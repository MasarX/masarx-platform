const {
  splitRunsByScript,
  reverseByGrapheme,
  measureTextWidthWithFallback,
  drawTextRunsWithFallback,
  measureBidiVisualWidthWithFallback,
  drawBidiVisualRunsWithFallback,
} = require('../../scripts/render/text-measure');

describe('text-measure (mixed-script font fallback)', () => {
  test('splitRunsByScript splits Arabic vs non-Arabic runs', () => {
    const runs = splitRunsByScript('Hello مرحبا SA');
    expect(runs).toEqual([
      { text: 'Hello ', isArabic: false },
      { text: 'مرحبا', isArabic: true },
      { text: ' SA', isArabic: false },
    ]);
  });

  test('measureTextWidthWithFallback sums widths across runs', () => {
    const arabicFont = { widthOfTextAtSize: (t, s) => t.length * s * 2 };
    const latinFont = { widthOfTextAtSize: (t, s) => t.length * s };
    const width = measureTextWidthWithFallback('AB مرحبا', 10, arabicFont, latinFont);
    // "AB " => 3 chars *10 + "مرحبا" => 5 chars *10*2
    expect(width).toBe(3 * 10 + 5 * 10 * 2);
  });

  test('drawTextRunsWithFallback draws per-run with correct x offsets', () => {
    const calls = [];
    const page = {
      drawText: (text, opts) => calls.push({ text, x: opts.x, y: opts.y, size: opts.size, font: opts.font }),
    };
    const arabicFont = { widthOfTextAtSize: (t, s) => t.length * s * 2 };
    const latinFont = { widthOfTextAtSize: (t, s) => t.length * s };

    drawTextRunsWithFallback(page, 'AB مرحبا', { x: 100, y: 50, size: 10, arabicFont, latinFont });

    expect(calls.map((c) => c.text)).toEqual(['AB ', 'مرحبا']);
    expect(calls[0].x).toBe(100);
    expect(calls[1].x).toBe(100 + 3 * 10);
  });

  test('measureBidiVisualWidthWithFallback measures Arabic runs as logical', () => {
    const arabicFont = { widthOfTextAtSize: (t) => (t === 'مكة' ? 10 : 1) };
    const latinFont = { widthOfTextAtSize: (t, s) => t.length * s };
    // Visual order for "SA مكة" is "SA ةكم" (Arabic run reversed).
    const width = measureBidiVisualWidthWithFallback('SA ةكم', 10, arabicFont, latinFont);
    expect(width).toBe(latinFont.widthOfTextAtSize('SA ', 10) + 10);
  });

  test('drawBidiVisualRunsWithFallback reverses Arabic runs before drawing', () => {
    const calls = [];
    const page = {
      drawText: (text, opts) => calls.push({ text, x: opts.x, font: opts.font }),
    };
    const arabicFont = { widthOfTextAtSize: (t) => (t === 'مكة' ? 10 : 1) };
    const latinFont = { widthOfTextAtSize: (t, s) => t.length * s };

    drawBidiVisualRunsWithFallback(page, 'SA ةكم', { x: 100, y: 50, size: 10, arabicFont, latinFont });

    expect(calls.map((c) => c.text)).toEqual(['SA ', 'مكة']);
    expect(calls[0].x).toBe(100);
    expect(calls[1].x).toBe(100 + latinFont.widthOfTextAtSize('SA ', 10));
  });

  test('reverseByGrapheme reverses Arabic graphemes', () => {
    expect(reverseByGrapheme('ةكم')).toBe('مكة');
  });
});
