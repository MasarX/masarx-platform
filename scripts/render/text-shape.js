const bidiFactory = require('bidi-js');
const { ArabicShaper } = require('arabic-persian-reshaper');

const bidi = bidiFactory();

// Covers Arabic, Arabic Supplement, Arabic Extended-A, and presentation forms.
const ARABIC_CHAR_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

const hasArabic = (text) => ARABIC_CHAR_RE.test(String(text ?? ''));

const toArabicPresentationForms = (text) => ArabicShaper.convertArabic(String(text ?? ''));

const normalizeBidiDirection = (direction) => {
  const d = String(direction || '').trim().toLowerCase();
  if (d === 'rtl') return 'rtl';
  if (d === 'ltr') return 'ltr';
  return undefined;
};

const toBidiVisualOrder = (text, direction) => {
  const input = String(text ?? '');
  if (input.length === 0) return input;
  const embeddingLevels = bidi.getEmbeddingLevels(input, normalizeBidiDirection(direction));
  return bidi.getReorderedString(input, embeddingLevels);
};

module.exports = {
  hasArabic,
  toArabicPresentationForms,
  toBidiVisualOrder,
};

