const fontHeightAtSize = (font, size) => (
  font && typeof font.heightAtSize === 'function' ? font.heightAtSize(size) : size
);

const normalizeText = (text) => String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const widestLineWidth = (font, lines, size, measureTextWidth) => {
  const measure = typeof measureTextWidth === 'function'
    ? measureTextWidth
    : (text, s) => font.widthOfTextAtSize(text, s);
  let max = 0;
  for (const line of lines) {
    const w = measure(line, size);
    if (w > max) max = w;
  }
  return max;
};

const breakWordToWidth = (word, font, size, maxWidth, measureTextWidth) => {
  const measure = typeof measureTextWidth === 'function'
    ? measureTextWidth
    : (text, s) => font.widthOfTextAtSize(text, s);
  if (!maxWidth || maxWidth <= 0) return [word];
  const segments = [];
  let rest = word;
  while (rest.length > 0) {
    // Find the longest prefix that fits.
    let lo = 1;
    let hi = rest.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate = rest.slice(0, mid);
      if (measure(candidate, size) <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    const head = rest.slice(0, lo);
    if (!head) {
      // If even 1 char doesn't fit, return the remainder; caller should shrink further.
      segments.push(rest);
      break;
    }
    segments.push(head);
    rest = rest.slice(lo);
  }
  return segments;
};

const wrapTextToWidth = (text, font, size, maxWidth, measureTextWidth) => {
  const measure = typeof measureTextWidth === 'function'
    ? measureTextWidth
    : (t, s) => font.widthOfTextAtSize(t, s);
  const raw = normalizeText(text);
  if (!maxWidth || maxWidth <= 0) return [raw.replace(/\n/g, ' ').trim()];

  const paragraphs = raw.split('\n');
  const lines = [];

  for (const paragraphRaw of paragraphs) {
    const paragraph = paragraphRaw.trim();
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = '';

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measure(candidate, size) <= maxWidth) {
        current = candidate;
        continue;
      }

      if (current) {
        lines.push(current);
        current = '';
      }

      if (measure(word, size) <= maxWidth) {
        current = word;
        continue;
      }

      const segments = breakWordToWidth(word, font, size, maxWidth, measureTextWidth);
      for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i];
        if (i === segments.length - 1) current = segment;
        else lines.push(segment);
      }
    }

    if (current) lines.push(current);
  }

  // Avoid returning an empty array.
  return lines.length ? lines : [''];
};

const fitTextSingleLineShrink = (text, font, size, maxWidth, maxHeight, opts = {}) => {
  const hardMinSize = Number.isFinite(Number(opts.hardMinSize))
    ? Number(opts.hardMinSize)
    : (Number.isFinite(Number(opts.minSize)) ? Number(opts.minSize) : 0.01);
  const measure = typeof opts.measureTextWidth === 'function'
    ? opts.measureTextWidth
    : (t, s) => font.widthOfTextAtSize(t, s);
  const raw = normalizeText(text).replace(/\n/g, ' ').trim();
  const heightAt = (s) => fontHeightAtSize(font, s);
  const fitsAt = (s) => (
    (!maxWidth || maxWidth <= 0 || measure(raw, s) <= maxWidth) &&
    (!maxHeight || maxHeight <= 0 || heightAt(s) <= maxHeight)
  );

  let fittedSize = Number(size) || 12;
  if (fitsAt(fittedSize)) {
    const widths = [measure(raw, fittedSize)];
    const textHeight = heightAt(fittedSize);
    return {
      mode: 'single',
      size: fittedSize,
      lines: [raw],
      widths,
      textHeight,
      lineHeight: textHeight,
      totalHeight: textHeight,
      fits: true,
    };
  }

  const w1 = maxWidth && maxWidth > 0 ? measure(raw, 1) : null;
  const h1 = maxHeight && maxHeight > 0 ? heightAt(1) : null;
  if (maxWidth && maxWidth > 0 && w1 && w1 > 0) fittedSize = Math.min(fittedSize, maxWidth / w1);
  if (maxHeight && maxHeight > 0 && h1 && h1 > 0) fittedSize = Math.min(fittedSize, maxHeight / h1);
  fittedSize = Math.max(hardMinSize, fittedSize * 0.995);

  while (fittedSize > hardMinSize && !fitsAt(fittedSize)) {
    fittedSize = Math.max(hardMinSize, fittedSize - 0.05);
  }

  const fits = fitsAt(fittedSize);
  const widths = [measure(raw, fittedSize)];
  const textHeight = heightAt(fittedSize);
  return {
    mode: 'single',
    size: fittedSize,
    lines: [raw],
    widths,
    textHeight,
    lineHeight: textHeight,
    totalHeight: textHeight,
    fits,
  };
};

const fitTextWrapShrink = (text, font, size, maxWidth, maxHeight, opts = {}) => {
  const hardMinSize = Number.isFinite(Number(opts.hardMinSize))
    ? Number(opts.hardMinSize)
    : (Number.isFinite(Number(opts.minSize)) ? Number(opts.minSize) : 0.01);
  const lineHeightFactor = Number.isFinite(Number(opts.lineHeightFactor)) ? Number(opts.lineHeightFactor) : 1.1;
  const measure = typeof opts.measureTextWidth === 'function'
    ? opts.measureTextWidth
    : (t, s) => font.widthOfTextAtSize(t, s);

  const measureAt = (s) => {
    const lines = wrapTextToWidth(text, font, s, maxWidth, opts.measureTextWidth);
    const textHeight = fontHeightAtSize(font, s);
    const lineHeight = textHeight * lineHeightFactor;
    const totalHeight = lines.length * lineHeight;
    const widths = lines.map((line) => measure(line, s));
    const fitsWidth = !maxWidth || maxWidth <= 0 || widths.every((w) => w <= maxWidth + 0.01);
    const fitsHeight = !maxHeight || maxHeight <= 0 || totalHeight <= maxHeight + 0.01;
    return {
      mode: 'wrap',
      size: s,
      lines,
      widths,
      textHeight,
      lineHeight,
      totalHeight,
      fits: fitsWidth && fitsHeight,
      fits_width: fitsWidth,
      fits_height: fitsHeight,
    };
  };

  const desired = Number(size) || 12;
  if (!maxHeight || maxHeight <= 0) return measureAt(desired);
  const desiredMeasure = measureAt(desired);
  if (desiredMeasure.fits) return desiredMeasure;

  const minMeasure = measureAt(hardMinSize);
  if (!minMeasure.fits_height) return minMeasure;

  let lo = hardMinSize;
  let hi = desired;
  let best = minMeasure;
  // Binary search for the largest size that fits.
  for (let i = 0; i < 18; i += 1) {
    const mid = (lo + hi) / 2;
    const m = measureAt(mid);
    if (m.fits) {
      best = m;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
};

const fitTextToBox = (text, font, size, maxWidth, maxHeight, opts = {}) => {
  const overflow = String(opts.overflow || 'shrink').toLowerCase();
  const wrap = opts.wrap === true || overflow.includes('wrap');
  if (wrap) return fitTextWrapShrink(text, font, size, maxWidth, maxHeight, opts);
  return fitTextSingleLineShrink(text, font, size, maxWidth, maxHeight, opts);
};

module.exports = {
  fontHeightAtSize,
  wrapTextToWidth,
  fitTextToBox,
  widestLineWidth,
};
