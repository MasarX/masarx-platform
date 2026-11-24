// WCAG 2.2 AA contrast for the design token pairs each surface uses (#301).
// Text pairs need 4.5:1 (1.4.3), component boundaries and focus need 3:1 (1.4.11).
// Values are read from the token files, so a token change that breaks a pair fails here.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TEXT = 4.5;
const BOUNDARY = 3;

// Merges every top-level `selector {` block in file order.
function readBlock(css, selector) {
  const vars = {};
  let found = false;
  for (const line of css.matchAll(/^(.+?)\s*\{/gm)) {
    if (line[1] !== selector) continue;
    found = true;
    const body = css.slice(line.index, css.indexOf('}', line.index));
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  }
  if (!found) throw new Error(`selector not found: ${selector}`);
  return vars;
}

// Each theme is the cascade of its selectors, later blocks winning.
function loadTheme(file, selectors) {
  const css = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return Object.assign({}, ...selectors.map((s) => readBlock(css, s)));
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function oklchToRgb(l, c, h) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return lin.map((v) => clamp01(linearToSrgb(v)) * 255);
}

// Returns [r, g, b, alpha] in 0-255 / 0-1.
function parseColor(raw, vars) {
  const value = raw.replace(/\/\*.*?\*\//g, '').trim();
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  if (ref) return parseColor(vars[ref[1]], vars);
  let m = value.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  m = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (m) return oklchToRgb(+m[1], +m[2], +m[3]).concat(1);
  m = value.match(/^([\d.]+)\s+([\d.]+)\s+([\d.]+)$/); // shared UI RGB channel triplet
  if (m) return [+m[1], +m[2], +m[3], 1];
  throw new Error(`unsupported color: ${raw}`);
}

const over = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => srgbToLinear(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// A color spec is a token name, optionally with `@alpha` for a tint, painted over `base` tokens.
function resolve(spec, vars, base) {
  const [name, alpha] = spec.split('@');
  const color = parseColor(vars[name] ?? name, vars);
  const rgba = alpha === undefined ? color : [...color.slice(0, 3), +alpha];
  if (rgba[3] >= 1) return rgba.slice(0, 3);
  return over(rgba, base.length ? resolve(base[0], vars, base.slice(1)) : [255, 255, 255]);
}

const TAG_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];

// [foreground, background stack (top first), minimum, where it is used]
const SURFACES = [
  {
    name: 'shared UI',
    file: 'packages/ui/src/styles.css',
    themes: { light: [':root'], dark: [':root', ':root[data-theme="dark"]'] },
    pairs: [
      ['--ui-ink', ['--ui-surface'], TEXT, 'body text'],
      ['--ui-ink', ['--ui-paper'], TEXT, 'page text'],
      ['--ui-muted', ['--ui-surface'], TEXT, 'secondary text'],
      ['--ui-muted', ['--ui-paper'], TEXT, 'secondary text on page'],
      ['--ui-muted', ['--ui-highlight'], TEXT, 'secondary text on highlight'],
      ['--ui-accent', ['--ui-surface'], TEXT, 'links and ghost buttons'],
      ['--ui-accent-ink', ['--ui-accent'], TEXT, 'solid button'],
      ['--ui-danger-ink', ['--ui-danger'], TEXT, 'danger button'],
      ['--ui-ink', ['--ui-accent-soft'], TEXT, 'accent badge'],
      ...['success', 'warning', 'danger', 'info'].flatMap((tone) => [
        [`--ui-${tone}`, ['--ui-surface'], TEXT, `${tone} text`],
        [`--ui-${tone}`, [`--ui-${tone}@0.12`, '--ui-surface'], TEXT, `${tone} badge`],
      ]),
      ['--ui-accent', ['--ui-surface'], BOUNDARY, 'focus ring'],
      ...TAG_COLORS.map((c) => [`--tag-${c}-text`, [`--tag-${c}-bg`], TEXT, `${c} tag`]),
    ],
  },
  {
    name: 'Console V2',
    file: 'apps/console-v2/src/styles/tokens.css',
    themes: { light: [':root', ':root[data-theme="light"]'], dark: [':root', ':root[data-theme="dark"]'] },
    pairs: [
      ...['--ink', '--ink-2', '--ink-3'].flatMap((ink) =>
        ['--paper', '--paper-2', '--paper-raise'].map((bg) => [ink, [bg], TEXT, `${ink} text on ${bg}`])
      ),
      ['--ink-inv', ['--accent'], TEXT, 'primary button'],
      ...['accent', 'warn', 'danger', 'info'].map((t) => [`--${t}-ink`, [`--${t}-soft`], TEXT, `${t} chip`]),
      ['--chrome-ink', ['--chrome'], TEXT, 'top bar text'],
      ['--chrome-ink-soft', ['--chrome'], TEXT, 'top bar secondary text'],
      ['--rail-ink', ['--rail-bg'], TEXT, 'navigation rail'],
      ['--accent', ['--paper'], BOUNDARY, 'focus ring'],
    ],
  },
  {
    name: 'landing and public tracking',
    file: 'docs/marketing/landing-v2/app.css',
    themes: {
      light: [':root', 'html[data-variant="ai"]', 'html[data-theme="light"]'],
      dark: [':root', 'html[data-variant="ai"]', 'html[data-theme="dark"]'],
    },
    pairs: [
      ['--text', ['--bg'], TEXT, 'body text'],
      ['--text', ['--surface', '--bg'], TEXT, 'card text'],
      ['--muted', ['--bg'], TEXT, 'secondary text'],
      ['--muted', ['--surface', '--bg'], TEXT, 'secondary card text'],
      ['--muted', ['--surface-strong'], TEXT, 'secondary text on solid surface'],
      ['--btn-primary-text', ['--brand'], TEXT, 'primary button'],
      ['--brand-text', ['--surface', '--bg'], TEXT, 'brand text on card (#423)'],
      ['--brand-text', ['--brand@0.03', '--surface', '--bg'], TEXT, 'brand heading on highlighted card (#423)'],
      ['--brand-text', ['--surface-strong'], TEXT, 'brand text on solid surface'],
    ],
  },
];

const cases = SURFACES.flatMap((s) =>
  Object.entries(s.themes).flatMap(([theme, selectors]) => {
    const vars = loadTheme(s.file, selectors);
    return s.pairs.map(([fg, bg, min, use]) => {
      const bgRgb = resolve(bg[0], vars, bg.slice(1));
      const ratio = contrast(resolve(fg, vars, bg), bgRgb);
      return { label: `${s.name} ${theme}: ${use} (${fg} on ${bg.join(' over ')})`, ratio, min };
    });
  })
);

describe('design token contrast (WCAG 2.2 AA)', () => {
  test('the converter matches known values', () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(oklchToRgb(1, 0, 0).map(Math.round)).toEqual([255, 255, 255]);
    expect(oklchToRgb(0.6279554, 0.2576833, 29.2338851).map(Math.round)).toEqual([255, 0, 0]);
  });

  test.each(cases.map((c) => [c.label, c]))('%s', (_label, { ratio, min }) => {
    expect(ratio).toBeGreaterThanOrEqual(min);
  });
});
