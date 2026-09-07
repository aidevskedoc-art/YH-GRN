// Generates the draped-fabric background plates used behind the whole UI.
//
// Each fold is drawn as a pair of blurred STROKES along one centreline rather
// than as a filled band with a gradient across it: a light stroke sitting just
// above the line (the lit ridge) and a wider dark one just below it (the valley
// it casts into). A cross-gradient cannot be used here, because a linear
// gradient is fixed in user space while the fold is diagonal - past the ends of
// the gradient's own y range it pads to a flat colour, and the boundary where
// that happens cuts a visible lens-shaped edge across the fold. A stroke
// follows the curve exactly, so the lighting stays correctly placed relative to
// the fold everywhere on the canvas.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const W = 1600;
const H = 1000;

// Deterministic PRNG so re-running never reshuffles a committed asset.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** One fold's centreline, as an SVG path. Ends are pushed well off-canvas so
 *  the stroke caps are never in frame. */
function fold(rand, i, n) {
  const t = i / (n - 1);
  const y0 = H * 1.3 - t * H * 1.62 + (rand() - 0.5) * H * 0.22;
  const slope = -0.34 - rand() * 0.16;
  const amp = 40 + rand() * 92;
  const period = 620 + rand() * 520;
  const phase = rand() * Math.PI * 2;
  const weight = 54 + rand() * 130;

  const pts = [];
  for (let x = -420; x <= W + 420; x += 40) {
    pts.push([x, y0 + slope * x + amp * Math.sin(x / period + phase)]);
  }

  return {
    t,
    weight,
    d: pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${p[0]} ${p[1].toFixed(1)}`).join(''),
  };
}

function plate({ file, base, deep, lit, shade, auroras, grain, seed, folds }) {
  const rand = rng(seed);
  const lines = Array.from({ length: folds }, (_, i) => fold(rand, i, folds));

  // The glow layers. Each is one very large, very soft radial ellipse, drawn ON
  // TOP of the folds so the cloth reads as being lit BY them - a light source
  // under a fold could not tint the ridge above it.
  //
  // A plain two-stop falloff, which spreads each glow across most of the plate.
  // That is what a single warm lamp in a room actually does, and with only one
  // or two of them there is nothing for it to muddy; it is only once several
  // differently-coloured glows overlap that the spread has to be pulled in.
  const auroraDefs = auroras
    .map(
      (a, i) => `
    <radialGradient id="a${i}" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${a.color}" stop-opacity="${a.opacity}"/>
      <stop offset="1" stop-color="${a.color}" stop-opacity="0"/>
    </radialGradient>`,
    )
    .join('');

  const auroraShapes = auroras
    .map(
      (a, i) =>
        `<ellipse cx="${(W * a.cx).toFixed(0)}" cy="${(H * a.cy).toFixed(0)}" ` +
        `rx="${(W * a.rx).toFixed(0)}" ry="${(H * a.ry).toFixed(0)}" fill="url(#a${i})"/>`,
    )
    .join('\n  ');

  // Valleys first, then ridges, so a highlight is never buried under the next
  // fold's shadow.
  const shadows = lines
    .map(
      (f) =>
        `<path d="${f.d}" fill="none" stroke="${shade}" stroke-width="${(f.weight * 1.05).toFixed(0)}" ` +
        `stroke-opacity="${(0.58 - f.t * 0.14).toFixed(2)}" transform="translate(0 ${(f.weight * 0.42).toFixed(0)})"/>`,
    )
    .join('\n    ');

  const ridges = lines
    .map(
      (f) =>
        `<path d="${f.d}" fill="none" stroke="${lit}" stroke-width="${(f.weight * 0.5).toFixed(0)}" ` +
        `stroke-opacity="${(0.10 + f.t * 0.19).toFixed(2)}" transform="translate(0 ${(-f.weight * 0.3).toFixed(0)})"/>`,
    )
    .join('\n    ');

  writeFileSync(
    file,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice">
  <defs>
    <radialGradient id="ground" cx="0.66" cy="0.10" r="1.18">
      <stop offset="0" stop-color="${base}"/>
      <stop offset="1" stop-color="${deep}"/>
    </radialGradient>
    <filter id="valley" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="46"/>
    </filter>
    <filter id="ridge" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="30"/>
    </filter>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="${seed}" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>${auroraDefs}
  </defs>

  <rect width="${W}" height="${H}" fill="url(#ground)"/>

  <g filter="url(#valley)">
    ${shadows}
  </g>
  <g filter="url(#ridge)">
    ${ridges}
  </g>

  ${auroraShapes}
  <rect width="${W}" height="${H}" filter="url(#grain)" opacity="${grain}" style="mix-blend-mode:overlay"/>
</svg>
`,
  );
}

// Writes straight into src/assets by default. The plates are committed, so this
// is only run when the drape itself is being retuned - never as part of a build.
const out = process.argv[2] || fileURLToPath(new URL('../src/assets', import.meta.url));

// The warm ground the whole design was built around: espresso cloth with the
// brand orange as the only light source in the room - one lamp high on the
// right, and its much fainter bounce off the floor at bottom left.
plate({
  file: `${out}/bg-drape-dark.svg`,
  base: '#1d150e',
  deep: '#050302',
  lit: '#b5936f',
  shade: '#000000',
  auroras: [
    { color: '#f58633', opacity: 0.18, cx: 0.80, cy: 0.04, rx: 0.54, ry: 0.62 },
    { color: '#f58633', opacity: 0.09, cx: 0.03, cy: 0.97, rx: 0.44, ry: 0.52 },
  ],
  grain: 0.055,
  seed: 21,
  folds: 9,
});

// The same room in daylight: unbleached paper, lit from the same two places.
plate({
  file: `${out}/bg-drape-light.svg`,
  base: '#f6efe4',
  deep: '#d8cab1',
  lit: '#ffffff',
  shade: '#8d7a5f',
  auroras: [
    { color: '#F58634', opacity: 0.14, cx: 0.80, cy: 0.04, rx: 0.54, ry: 0.62 },
    { color: '#F58634', opacity: 0.07, cx: 0.03, cy: 0.97, rx: 0.44, ry: 0.52 },
  ],
  grain: 0.05,
  seed: 21,
  folds: 9,
});

console.log('wrote drape plates');
