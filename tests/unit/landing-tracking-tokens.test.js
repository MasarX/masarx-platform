const fs = require('fs');
const path = require('path');

const { readSharedUiTokenCss } = require('../../scripts/frontend/landing-shared-tokens');

const repoRoot = path.resolve(__dirname, '..', '..');
const css = readSharedUiTokenCss(repoRoot) + fs.readFileSync(
  path.join(repoRoot, 'docs', 'marketing', 'landing-v2', 'app.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

// Innermost `selector { declarations }` blocks; @media wrappers fall away because their body holds braces.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selector: selector.trim().replace(/\s+/g, ' '),
  body,
}));
const trackingRules = rules.filter(({ selector }) => /\.track-|\.pod-|\.choices?\b|\[data-track-/.test(selector));
const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name));

describe('landing tracking styles', () => {
  it('finds the tracking rules', () => {
    expect(trackingRules.length).toBeGreaterThan(40);
  });

  it('uses only variables defined in the landing tokens', () => {
    const undefinedVars = trackingRules.flatMap(({ selector, body }) =>
      [...body.matchAll(/var\((--[\w-]+)/g)]
        .map(([, name]) => name)
        .filter((name) => !defined.has(name))
        .map((name) => `${selector}: ${name}`),
    );
    expect(undefinedVars).toEqual([]);
  });

  it('uses no colour literals', () => {
    const literals = trackingRules.flatMap(({ selector, body }) =>
      (body.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\((?!\s*var\(--[\w-]+\)\s*\))|(?<![\w-])(?:white|black)(?![\w-])/gi) || []).map(
        (literal) => `${selector}: ${literal}`,
      ),
    );
    expect(literals).toEqual([]);
  });

  it('draws the timeline on the inline-start edge', () => {
    const timeline = trackingRules.filter(({ selector }) => selector.includes('.track-timeline'));
    const body = timeline.map((rule) => rule.body).join('\n');
    expect(body).toMatch(/border-inline-start:[^;]*var\(--[\w-]+\)/);
    expect(body).toMatch(/inset-inline-start:/);
    expect(body).not.toMatch(/\b(?:border|padding|margin)-(?:left|right)\b|(?:^|[\s;])(?:left|right)\s*:/m);
  });
});
