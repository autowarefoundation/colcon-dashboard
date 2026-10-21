// Copied from the logo project (colcon-dashboard-logo, liquid-tube/tools/logo.mjs).
// The dashboard uses it to draw the live tab icon. Change the logo there, then copy it here.
// The colcon-dashboard logo: "liquid tube C" (from round 2, S26).
//
// Construction: a tube bent into a C around the center (50, 50) of a
// 100 x 100 view box. Angles are in degrees, 0 is +x, and they grow
// clockwise (y points down). The C opens to the right with a gap of `gap`
// degrees, so its ends sit at gap/2 (lower) and 360 - gap/2 (upper).
//
// The nodes of the dependency graph are `dots` evenly spaced dots, from the
// lower end of the C to the upper end. Their positions are symmetric about
// the horizontal axis. One of them is the blue build front: `blueFromEnd`
// counts back from the upper end (1 is the dot before the last one).
// Green liquid is the progress bar. It fills the tube from the lower end up
// to the blue node, so it is not symmetric. Dots in the liquid are done,
// and dots after the blue node wait in the empty tube.
//
// One module serves both the designer page (tools/designer.html) and the
// command line: `node tools/logo.mjs '<json settings>' <version> [dark]`
// prints one SVG file. The versions are flat, rich, and mono.
//
// The rich version follows the style of the Rivorbit logo, which follows the
// Microsoft Edge logo. The empty tube is the ink part, like the Rivorbit disc:
// navy on light backgrounds and white on dark ones, with a round gradient
// whose bright spot sits toward the light (upper left). The liquid and the
// blue node run from a lighter tip to a deeper base, with small OKLCH steps.
// Each upper part casts a soft shadow toward the lower right onto the parts
// under it: black on the liquid, and its own color on the ink, where it reads
// as a glow. Each cutout (the dot holes and the cut around the knob) has a
// soft dark ring on the part around it. Each shadow is a copy of the receiving shape, filled with a
// radial gradient that fades to transparent, so the file needs no filters,
// clip paths, or masks. The dots are holes, like the Rivorbit center.

export const DEFAULTS = {
  r: 30,          // radius of the tube center line
  tube: 22,       // tube width
  gap: 80,        // opening of the C, in degrees
  dots: 5,        // evenly spaced dots, end to end
  inset: 0,       // pulls the first and the last dot in from the ends, in degrees
  blueFromEnd: 1, // which dot is blue, counted back from the upper end
  dot: 0.45,      // dot radius, as a share of half the tube width
  blue: 1.08,     // blue knob radius, as a share of half the tube width (above 1, it is wider than the tube)
  knobGap: 3.5,
  paleTrack: false, // false: the empty tube is the ink (navy, or white on dark). true: pale blue.   // the cut through the tube around the knob, in view box units (flat and rich)
  // Rich version only, after the Rivorbit logo:
  gradient: 1,    // strength of the gradients
  shadeOffset: 1.6, // shadow offset toward the lower right, in view box units
  shadeBlur: 2,   // shadow softness (the sigma of a Gaussian blur)
  shadeOpacity: 0.3, // shadow of the blue node on the green liquid
  cutShade: 0.16, // the soft dark ring around each cutout (dot holes and the cut around the knob)
  cutBlur: 1.2,   // softness of that ring
  // Live use (the dashboard tab icon):
  progress: null, // a number from 0 to 1 puts the knob anywhere on the C, in place of blueFromEnd
  knob: null,     // a color for the knob, for example red for a failed build
};

// Colors after Windows 7: the green of its progress bar, the blue of the Harmony
// wallpaper and the Start orb, the deep navy at the dark edge of that wallpaper,
// and the pale blue of its selection highlight (the paleTrack option).
export const PALETTES = {
  // rich: the ink is the empty tube.
  richLight: { green: "#06b025", blue: "#1e7fd9", ink: "#0a1f3d", pale: "#cce4f7", glow: 0.55 },
  richDark: { green: "#2bd14a", blue: "#3a95ea", ink: "#ffffff", pale: "#2b4a6e", glow: 0.75 },
  light: { green: "#06b025", blue: "#1e7fd9", ink: "#0a1f3d", pale: "#cce4f7" },
  dark: { green: "#2bd14a", blue: "#3a95ea", ink: "#ffffff", pale: "#2b4a6e" },
};

const f = (n) => (Math.round(n * 100) / 100).toString();

function pt(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [50 + r * Math.cos(a), 50 + r * Math.sin(a)];
}

function arcD(r, a0, a1) {
  const [x0, y0] = pt(r, a0);
  const [x1, y1] = pt(r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${f(x0)} ${f(y0)} A${r} ${r} 0 ${large} 1 ${f(x1)} ${f(y1)}`;
}

function stroke(d, color, w, cap = "round") {
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${f(w)}" stroke-linecap="${cap}"/>`;
}

const circle = (x, y, r, fill) => `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${fill}"/>`;

/** The ends of the C, the end of the liquid, and the dots with their states. */
export function layout(p) {
  const lo = p.gap / 2;
  const hi = 360 - lo;
  const first = lo + p.inset;
  const last = hi - p.inset;
  const n = Math.max(2, Math.round(p.dots));
  if (p.progress != null) {
    // A live progress value (0 to 1) puts the knob anywhere on the C. The dots
    // keep their places, and a dot that the knob or its cut would cover is left out.
    const front = lo + Math.max(0, Math.min(1, p.progress)) * (hi - lo);
    const room = ((((p.tube / 2) * (p.blue + p.dot)) + p.knobGap) / p.r) * (180 / Math.PI);
    const nodes = [];
    for (let i = 0; i < n; i++) {
      const a = first + (i * (last - first)) / (n - 1);
      if (Math.abs(a - front) >= room) nodes.push({ a, state: a < front ? "done" : "waiting" });
    }
    nodes.push({ a: front, state: "front" });
    nodes.sort((x, y) => x.a - y.a);
    return { lo, hi, front, arcs: front > lo ? [[lo, front]] : [], nodes };
  }
  const blue = n - 1 - Math.max(0, Math.min(n - 1, Math.round(p.blueFromEnd)));
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const a = first + (i * (last - first)) / (n - 1);
    nodes.push({ a, state: i < blue ? "done" : i === blue ? "front" : "waiting" });
  }
  const front = nodes[blue].a;
  return { lo, hi, front, arcs: front > lo ? [[lo, front]] : [], nodes };
}

function flat(p, c) {
  // The rich version without gradients and shadows: the same tube parts, holes, and knob.
  const { lo, hi, front, nodes } = layout(p);
  const rt = p.tube / 2;
  const holes = (state) => nodes.filter((n) => n.state === state).map((n) => [...pt(p.r, n.a), rt * p.dot]);
  const path = (d, fill) => (d ? `<path fill-rule="evenodd" fill="${fill}" d="${d}"/>` : "");
  let body = path(bandD(p, { a: front, kind: "knob" }, { a: hi, kind: "round" }, holes("waiting")), p.paleTrack ? c.pale : c.ink);
  body += path(bandD(p, { a: lo, kind: "round" }, { a: front, kind: "knob" }, holes("done")), c.green);
  body += circle(...pt(p.r, front), rt * p.blue, c.knob);
  return body;
}

function mono(p, c, u) {
  // One ink. The filled part of the tube is solid, with the done dots as holes.
  // The empty part is a closed outline: it follows the tube edges, the round
  // upper end, and the cut around the knob. Its corners at the cut are as
  // crisp as the corners of the solid part, as in the flat and rich versions.
  const { lo, hi, front, nodes } = layout(p);
  const rt = p.tube / 2;
  const wall = Math.max(2.5, p.tube * 0.18);
  const holes = nodes.filter((n) => n.state === "done").map((n) => [...pt(p.r, n.a), rt * p.dot]);
  let body = "";
  const solid = bandD(p, { a: lo, kind: "round" }, { a: front, kind: "knob" }, holes);
  if (solid) body += `<path fill-rule="evenodd" fill="${c.ink}" d="${solid}"/>`;
  // The empty part, shrunk by d on every side: the tube is narrower, and the cut around the knob is wider.
  const rho = rt * p.blue + p.knobGap;
  const shrunk = (d) => {
    const q = { ...p, tube: p.tube - 2 * d };
    q.knobGap = rho + d - (q.tube / 2) * p.blue;
    return bandD(q, { a: front, kind: "knob" }, { a: hi, kind: "round" });
  };
  const shape = (d, color) => {
    const sd = shrunk(d);
    return sd ? `<path fill="${color}" d="${sd}"/>` : "";
  };
  const outer = shape(0, "#fff");
  if (outer) {
    const mask = `<mask id="${u}-m" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">${outer}${shape(wall, "#000")}</mask>`;
    body = `<defs>${mask}</defs>` + body + `<rect width="100" height="100" fill="${c.ink}" mask="url(#${u}-m)"/>`;
  }
  for (const n of nodes) {
    const [x, y] = pt(p.r, n.a);
    if (n.state === "front") body += circle(x, y, rt * p.blue, c.ink);
    if (n.state === "waiting") body += circle(x, y, rt * p.dot, c.ink);
  }
  return body;
}


// ---------------------------------------------------------------- rich

function toOklch(hex) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const [l, m, s] = [0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
    0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b].map(Math.cbrt);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function fromOklch(L, C, h) {
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const [l, m, s] = [L + 0.3963377774 * a + 0.2158037573 * b, L - 0.1055613458 * a - 0.0638541728 * b,
    L - 0.0894841775 * a - 1.291485548 * b].map((x) => x ** 3);
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const srgb = (c) => { c = Math.min(1, Math.max(0, c)); return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; };
  return "#" + rgb.map((c) => Math.round(srgb(c) * 255).toString(16).padStart(2, "0")).join("");
}

/** The color with its OKLCH lightness and chroma moved, and its hue turned by dh degrees. */
export function tone(hex, dl, dc = 0, dh = 0) {
  const [L, C, h] = toOklch(hex);
  return fromOklch(Math.min(0.98, L + dl), Math.max(0, C + dc), h + (dh * Math.PI) / 180);
}

function erf(x) {
  // Abramowitz and Stegun 7.1.26, as in the Rivorbit generator.
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/**
 * The arc of the circle (cx, cy, rho) from point q0 to point q1 that passes on
 * the side of the point (vx, vy), as an SVG arc command.
 */
function arcAround(cx, cy, rho, q0, q1, vx, vy) {
  const ang = (q) => Math.atan2(q[1] - cy, q[0] - cx);
  const tau = 2 * Math.PI;
  const mod = (x) => ((x % tau) + tau) % tau;
  const d01 = mod(ang(q1) - ang(q0)), d0v = mod(Math.atan2(vy - cy, vx - cx) - ang(q0));
  const sweep = d0v < d01 ? 1 : 0;
  const span = sweep ? d01 : tau - d01;
  return `A${f(rho)} ${f(rho)} 0 ${span > Math.PI ? 1 : 0} ${sweep} ${f(q1[0])} ${f(q1[1])}`;
}

/**
 * A tube segment as a filled outline. Each end is {a, kind}: kind "round"
 * is a round end, and kind "knob" is a concave cut around the knob at angle
 * a, at the distance of the knob radius plus the knob gap. holes are round
 * holes [x, y, r] inside the tube (use fill-rule evenodd).
 */
function bandD(p, s0, s1, holes = []) {
  const ro = p.r + p.tube / 2, ri = p.r - p.tube / 2, rc = p.tube / 2;
  const rho = (p.tube / 2) * p.blue + p.knobGap;
  // The angle between the knob center and the point where the cut meets a tube edge of radius re.
  const cutAt = (re) => (Math.acos(Math.max(-1, Math.min(1, (re * re + p.r * p.r - rho * rho) / (2 * re * p.r)))) * 180) / Math.PI;
  const dO = cutAt(ro), dI = cutAt(ri);
  const oa0 = s0.kind === "knob" ? s0.a + dO : s0.a, ia0 = s0.kind === "knob" ? s0.a + dI : s0.a;
  const oa1 = s1.kind === "knob" ? s1.a - dO : s1.a, ia1 = s1.kind === "knob" ? s1.a - dI : s1.a;
  if (oa1 <= oa0 || ia1 <= ia0) return "";
  const O0 = pt(ro, oa0), O1 = pt(ro, oa1), I0 = pt(ri, ia0), I1 = pt(ri, ia1);
  // The cut is the arc of the knob circle that crosses the tube. It passes through the
  // point where the knob circle meets the center line of the tube, on the side of this part.
  const knob = (s, side) => {
    const [kx, ky] = pt(p.r, s.a);
    const [vx, vy] = pt(p.r, s.a + side * cutAt(p.r));
    return [kx, ky, vx, vy];
  };
  let d = `M${f(O0[0])} ${f(O0[1])} A${f(ro)} ${f(ro)} 0 ${oa1 - oa0 > 180 ? 1 : 0} 1 ${f(O1[0])} ${f(O1[1])} `;
  if (s1.kind === "knob") { const [kx, ky, vx, vy] = knob(s1, -1); d += arcAround(kx, ky, rho, O1, I1, vx, vy) + " "; }
  else d += `A${f(rc)} ${f(rc)} 0 0 1 ${f(I1[0])} ${f(I1[1])} `;
  d += `A${f(ri)} ${f(ri)} 0 ${ia1 - ia0 > 180 ? 1 : 0} 0 ${f(I0[0])} ${f(I0[1])} `;
  if (s0.kind === "knob") { const [kx, ky, vx, vy] = knob(s0, 1); d += arcAround(kx, ky, rho, I0, O0, vx, vy) + " Z"; }
  else d += `A${f(rc)} ${f(rc)} 0 0 1 ${f(O0[0])} ${f(O0[1])} Z`;
  for (const [x, y, r] of holes) {
    d += ` M${f(x - r)} ${f(y)} A${f(r)} ${f(r)} 0 0 0 ${f(x + r)} ${f(y)} A${f(r)} ${f(r)} 0 0 0 ${f(x - r)} ${f(y)} Z`;
  }
  return d;
}

function rich(p, c, u) {
  const { lo, hi, front, nodes } = layout(p);
  const k = p.gradient;
  const rt = p.tube / 2;
  const holeR = rt * p.dot;
  const holes = (state) => nodes.filter((n) => n.state === state).map((n) => [...pt(p.r, n.a), holeR]);
  const [bx, by] = pt(p.r, front);
  const br = rt * p.blue;
  const defs = [];
  const lin = (id, x0, y0, x1, y1, c0, c1) => defs.push(
    `<linearGradient id="${u}-${id}" gradientUnits="userSpaceOnUse" x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}">` +
    `<stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c1}"/></linearGradient>`);

  // The ink tube: lighter at the knob, which lights it, and deeper toward its upper end.
  // A dark ink gets lighter and a little bluer, and a light ink (white) turns to a soft blue gray.
  const ink = p.paleTrack ? c.pale : c.ink;
  const [inkL] = toOklch(ink);
  const blueHue = toOklch(c.blue)[2];
  const [near, far] = inkL < 0.5 ? [tone(ink, 0.17 * k, 0.05 * k), ink]
    : [ink, fromOklch(inkL - 0.14 * k, 0.025 * k, blueHue)];
  const [tx, ty] = pt(p.r, hi);
  lin("ink", bx, by, tx, ty, near, far);
  // The liquid: lighter at its tip (the build front) and deeper at its base. Its hue stays
  // the clean green of the Windows 7 progress bar, without the Rivorbit turn toward yellow.
  const [gx0, gy0] = pt(p.r, lo);
  lin("green", bx, by, gx0, gy0, tone(c.green, 0.09 * k, -0.02 * k), tone(c.green, -0.07 * k, -0.01 * k));
  // The blue node: lighter toward the light, deeper away from it.
  lin("blue", bx - br * 0.7, by - br * 0.7, bx + br * 0.7, by + br * 0.7, tone(c.knob, 0.08 * k, -0.03 * k), tone(c.knob, -0.16 * k, 0.03 * k));

  // Soft shadows, drawn as in the Edge logo: a circle edge, moved by the offset,
  // with a radial gradient that follows the blur. Inside the edge, the caster covers it.
  const sigma = p.shadeBlur, shift = p.shadeOffset;
  const mx = shift * Math.cos((300 * Math.PI) / 180), my = -shift * Math.sin((300 * Math.PI) / 180);
  const soft = (id, cx, cy, rho, color, opacity, shift = p.shadeOffset, sigma = p.shadeBlur) => {
    const ang = (300 * Math.PI) / 180;
    const mx = shift * Math.cos(ang), my = -shift * Math.sin(ang);
    const cut = -shift - 0.4 * sigma;
    const vs = [...new Set([cut - 1, cut, -shift, -sigma, -0.5 * sigma, 0, 0.5 * sigma, sigma, 1.5 * sigma, 2 * sigma, 3 * sigma])]
      .filter((v) => v >= cut - 1 && rho + v >= 0).sort((a, b) => a - b);
    const size = rho + 3 * sigma;
    const stops = vs.map((v) => {
      const o = v < cut + 0.1 ? 0 : opacity * 0.5 * (1 - erf(v / sigma / Math.SQRT2));
      return `<stop offset="${(Math.max(0, rho + v) / size).toFixed(4)}" stop-color="${color}" stop-opacity="${o.toFixed(3)}"/>`;
    }).join("");
    defs.push(`<radialGradient id="${u}-${id}" gradientUnits="userSpaceOnUse" cx="${f(cx + mx)}" cy="${f(cy + my)}" r="${f(size)}">${stops}</radialGradient>`);
    return `url(#${u}-${id})`;
  };

  // The tube is cut around the knob, so the liquid and the ink tube do not touch.
  // The knob shines onto the ink tube in its own color, and casts a shadow onto the liquid.
  const track = bandD(p, { a: front, kind: "knob" }, { a: hi, kind: "round" }, holes("waiting"));
  const liquid = bandD(p, { a: lo, kind: "round" }, { a: front, kind: "knob" }, holes("done"));
  const path = (d, fill) => (d ? `<path fill-rule="evenodd" fill="${fill}" d="${d}"/>` : "");
  // Each cutout gets a soft dark ring on the part around it, with no offset, so that it reads as cut into the part.
  const rho = br + p.knobGap;
  const rings = (d, name, cut) => {
    if (!d || p.cutShade <= 0) return "";
    const list = [...cut, [bx, by, rho]];
    return list.map(([x, y, r], i) => path(d, soft(`cut-${name}-${i}`, x, y, r, "#000000", p.cutShade, 0, p.cutBlur))).join("");
  };
  let body = path(track, `url(#${u}-ink)`);
  if (track) body += path(track, soft("blue-on-ink", bx, by, br, c.knob, c.glow));
  body += rings(track, "ink", holes("waiting"));
  body += path(liquid, `url(#${u}-green)`);
  body += rings(liquid, "green", holes("done"));
  if (liquid) body += path(liquid, soft("blue-on-green", bx, by, br, "#000000", p.shadeOpacity));
  body += circle(bx, by, br, `url(#${u}-blue)`);
  return `<defs>${defs.join("")}</defs>${body}`;
}

/** One SVG file. version: flat, rich, or mono. */
export function svg(settings = {}, version = "flat", dark = false, size = 512) {
  const p = { ...DEFAULTS, ...settings };
  const base = version === "rich" ? (dark ? PALETTES.richDark : PALETTES.richLight) : dark ? PALETTES.dark : PALETTES.light;
  const c = { ...base, knob: p.knob || base.blue };
  const u = `cdl-${version}${dark ? "-dark" : ""}`;
  const body = { flat, rich, mono }[version](p, c, u);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">` +
    `<title>colcon-dashboard</title>${body}</svg>\n`;
}

if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
  const [json = "{}", version = "flat", dark = ""] = process.argv.slice(2);
  process.stdout.write(svg(JSON.parse(json), version, dark === "dark"));
}
