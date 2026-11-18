const postcss = require('postcss');
const tailwindcss = require('tailwindcss');
const postcssNested = require('postcss-nested');
const fixture = require('../../fixtures/css-selector-security-compatibility.json');

describe('patched selector parser parent compatibility', () => {
  test('preserves Tailwind variants, apply expansion, and nested selectors', async () => {
    const result = await postcss([
      tailwindcss({
        content: [{ raw: fixture.content, extension: 'html' }],
        corePlugins: { preflight: false },
        darkMode: 'class',
      }),
      postcssNested(),
    ]).process(fixture.tailwind_css, { from: undefined });

    expect(result.warnings()).toEqual([]);
    for (const expected of fixture.tailwind_expected) expect(result.css).toContain(expected);
    expect(result.css).not.toContain('@apply');
    expect(result.css).not.toContain('@tailwind');
  });

  test('preserves comma lists and repeated nesting inside functional pseudos', async () => {
    const result = await postcss([postcssNested()]).process(fixture.nested_css, { from: undefined });

    expect(result.warnings()).toEqual([]);
    for (const expected of fixture.nested_expected) expect(result.css).toContain(expected);
    expect(result.css).not.toContain('&');
  });
});
