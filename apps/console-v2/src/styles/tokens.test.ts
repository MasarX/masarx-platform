import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(resolve(TEST_DIR, 'tokens.css'), 'utf8');
const shared = readFileSync(resolve(TEST_DIR, '../../../../packages/ui/src/styles.css'), 'utf8');

function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no "${selector}" block`);
  return css.slice(start, css.indexOf('\n}', start));
}

/** Declarations of a block, without comments, in source order. */
function declarations(css: string): Map<string, string> {
  const decls = new Map<string, string>();
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    decls.set(m[1]!, m[2]!.trim());
  }
  return decls;
}

/** CSS Color 4 OKLCH to sRGB, as 0–255 channels. */
function oklchToSrgb(l: number, c: number, h: number): number[] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const lms = [
    l + 0.3963377773740556 * a + 0.2158037573099136 * b,
    l - 0.1055613458156586 * a - 0.0638541728258133 * b,
    l - 0.0894841775298119 * a - 1.2914855480194092 * b,
  ].map((v) => v ** 3);
  const [L, M, S] = lms as [number, number, number];
  const linear = [
    4.0767416360759583 * L - 3.3077115392580629 * M + 0.2309699031821043 * S,
    -1.2684380040921763 * L + 2.6097574006633715 * M - 0.3413193963102197 * S,
    -0.0041960863789809 * L - 0.7034186144594493 * M + 1.7076147009309444 * S,
  ];
  return linear.map((x) => 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
}

const sharedRoot = declarations(block(shared, ':root'));
const root = declarations(block(tokens, ':root'));

describe.each(['light', 'dark'])('Console V2 %s tokens', (theme) => {
  const themeBlock = block(tokens, `:root[data-theme="${theme}"]`);
  const decls = declarations(themeBlock);
  const overrides = [...decls].filter(([name]) => name.startsWith('--ui-'));

  it('overrides only shared --ui-* names', () => {
    expect(overrides.length).toBeGreaterThan(0);
    for (const [name] of overrides) expect(sharedRoot.has(name), name).toBe(true);
  });

  it('keeps each override equal to the OKLCH colour it replaced', () => {
    for (const [name, value] of overrides) {
      const line = themeBlock.split('\n').find((l) => l.includes(`${name}:`))!;
      const source = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(line);
      expect(source, `${name} documents its OKLCH source`).not.toBeNull();
      const expected = oklchToSrgb(Number(source![1]), Number(source![2]), Number(source![3]));
      value
        .split(' ')
        .map(Number)
        .forEach((channel, i) => {
          expect(Math.abs(channel - expected[i]!), `${name} channel ${i}`).toBeLessThan(0.01);
        });
    }
  });

  it('aliases every override and resolves every var() reference', () => {
    const aliased = [...decls.values()].join(' ');
    for (const [name] of overrides) expect(aliased.includes(`rgb(var(${name}))`), name).toBe(true);
    for (const [name, value] of decls) {
      for (const [, ref] of value.matchAll(/var\((--[\w-]+)\)/g)) {
        expect(decls.has(ref!) || root.has(ref!), `${name} -> ${ref}`).toBe(true);
      }
    }
  });
});

describe('Console V2 font tokens', () => {
  it('build --font-display and --font-mono from the shared --app-font-* inputs', () => {
    for (const name of ['--font-ui', '--font-display', '--font-mono']) {
      for (const [, ref] of root.get(name)!.matchAll(/var\((--[\w-]+)\)/g)) {
        expect(
          ref!.startsWith('--app-font-') && sharedRoot.has(ref!) && root.has(ref!),
          `${name} -> ${ref}`,
        ).toBe(true);
      }
    }
    const resolveVars = (value: string) =>
      value.replace(/var\((--[\w-]+)\)/g, (_, ref: string) => root.get(ref)!);
    expect(resolveVars(root.get('--font-display')!)).toBe(
      "'Geist', 'IBM Plex Sans Arabic', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    );
    expect(resolveVars(root.get('--font-mono')!)).toBe(
      "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    );
  });
});
