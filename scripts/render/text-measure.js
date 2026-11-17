const { hasArabic } = require('./text-shape');

const splitRunsByScript = (text, isArabicChar = hasArabic) => {
  const input = String(text ?? '');
  if (input.length === 0) return [];

  const runs = [];
  let currentText = '';
  let currentIsArabic = null;

  for (const ch of input) {
    const arabic = isArabicChar(ch);
    if (currentIsArabic === null) {
      currentIsArabic = arabic;
      currentText = ch;
      continue;
    }

    if (arabic === currentIsArabic) {
      currentText += ch;
      continue;
    }

    runs.push({ text: currentText, isArabic: currentIsArabic });
    currentIsArabic = arabic;
    currentText = ch;
  }

  runs.push({ text: currentText, isArabic: currentIsArabic });
  return runs;
};

const reverseByGrapheme = (text, locale = 'ar') => {
  const input = String(text ?? '');
  if (input.length === 0) return input;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      const seg = new Intl.Segmenter(locale, { granularity: 'grapheme' });
      const graphemes = Array.from(seg.segment(input), (s) => s.segment);
      graphemes.reverse();
      return graphemes.join('');
    }
  } catch (_err) {
    // Fall back to codepoint reversal below.
  }
  return Array.from(input).reverse().join('');
};

const measureTextWidthWithFallback = (text, size, arabicFont, latinFont) => {
  const runs = splitRunsByScript(text);
  let total = 0;
  for (const run of runs) {
    const font = run.isArabic ? arabicFont : latinFont;
    if (!font || typeof font.widthOfTextAtSize !== 'function') continue;
    total += font.widthOfTextAtSize(run.text, size);
  }
  return total;
};

const drawTextRunsWithFallback = (page, text, opts) => {
  const {
    x,
    y,
    size,
    arabicFont,
    latinFont,
    color,
    rotate,
  } = opts || {};

  const runs = splitRunsByScript(text);
  let cursorX = x;
  for (const run of runs) {
    const font = run.isArabic ? arabicFont : latinFont;
    if (!font) continue;
    page.drawText(run.text, { x: cursorX, y, size, font, color, rotate });
    cursorX += font.widthOfTextAtSize(run.text, size);
  }
};

// When using pdf-lib custom fonts, fontkit already performs RTL glyph reordering during layout.
// For mixed-script lines where we draw Latin with a StandardFont and Arabic with a custom font,
// we treat `text` as *visual order* (LTR string). Arabic runs must be reversed back to logical
// order before passing into the RTL-aware font.
const measureBidiVisualWidthWithFallback = (visualText, size, arabicFont, latinFont) => {
  const runs = splitRunsByScript(visualText);
  let total = 0;
  for (const run of runs) {
    if (run.isArabic) {
      const logical = reverseByGrapheme(run.text, 'ar');
      if (arabicFont && typeof arabicFont.widthOfTextAtSize === 'function') {
        total += arabicFont.widthOfTextAtSize(logical, size);
      }
      continue;
    }
    if (latinFont && typeof latinFont.widthOfTextAtSize === 'function') {
      total += latinFont.widthOfTextAtSize(run.text, size);
    }
  }
  return total;
};

const drawBidiVisualRunsWithFallback = (page, visualText, opts) => {
  const {
    x,
    y,
    size,
    arabicFont,
    latinFont,
    color,
    rotate,
  } = opts || {};

  const runs = splitRunsByScript(visualText);
  let cursorX = x;
  for (const run of runs) {
    if (run.isArabic) {
      const logical = reverseByGrapheme(run.text, 'ar');
      if (!arabicFont) continue;
      page.drawText(logical, { x: cursorX, y, size, font: arabicFont, color, rotate });
      cursorX += arabicFont.widthOfTextAtSize(logical, size);
      continue;
    }

    if (!latinFont) continue;
    page.drawText(run.text, { x: cursorX, y, size, font: latinFont, color, rotate });
    cursorX += latinFont.widthOfTextAtSize(run.text, size);
  }
};

module.exports = {
  splitRunsByScript,
  reverseByGrapheme,
  measureTextWidthWithFallback,
  drawTextRunsWithFallback,
  measureBidiVisualWidthWithFallback,
  drawBidiVisualRunsWithFallback,
};
