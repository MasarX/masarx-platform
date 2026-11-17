const { hasArabic, toArabicPresentationForms, toBidiVisualOrder } = require('../../scripts/render/text-shape');

describe('text-shape (Arabic + bidi)', () => {
  test('hasArabic detects Arabic ranges', () => {
    expect(hasArabic('hello')).toBe(false);
    expect(hasArabic('مكة')).toBe(true);
    expect(hasArabic('DANTE | دانتي')).toBe(true);
  });

  test('toArabicPresentationForms converts Arabic joining forms', () => {
    expect(toArabicPresentationForms('مكة')).toBe('ﻣﻜﺔ');
  });

  test('toBidiVisualOrder reorders RTL strings for LTR drawing', () => {
    expect(toBidiVisualOrder('مكة', 'rtl')).toBe('ةكم');
    expect(toBidiVisualOrder('SA مكة', 'auto')).toBe('SA ةكم');
  });
});
