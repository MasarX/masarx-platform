// shortcut: identity/basic structure only; use a decoder/sanitizer if pixel, CRC/entropy or SVG-content guarantees become required.
// Framing: https://www.w3.org/TR/png-3/#5Chunk-layout and https://github.com/jpeg-js/jpeg-js/blob/v0.4.4/lib/decoder.js.
export const isPngContainer = (bytes) => {
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let hasData = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) return false;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13 || !view.getUint32(offset + 8) || !view.getUint32(offset + 12)) return false;
      if (bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) return false;
    } else if (type === "IHDR") return false;
    if (type === "IDAT" && length > 0) hasData = true;
    const end = offset + length + 12;
    if (type === "IEND") return length === 0 && hasData && end === bytes.length;
    offset = end;
  }
  return false;
};

const scanJpeg = (bytes, onMetadata) => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  let hasFrame = false;
  let hasScan = false;
  while (offset < bytes.length) {
    const segmentStart = offset;
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++];
    if (marker === 0xd9) return hasFrame && hasScan && offset === bytes.length;
    if (marker === 0x01) continue;
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > bytes.length) return false;
    const length = view.getUint16(offset);
    if (length < 2 || length > bytes.length - offset) return false;
    const end = offset + length;
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) onMetadata?.(segmentStart, end, marker, offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8 || !bytes[offset + 7] || length !== 8 + 3 * bytes[offset + 7]) return false;
      hasFrame = true;
    }
    if (marker !== 0xda) {
      offset = end;
      continue;
    }
    if (!hasFrame || length < 6 || !bytes[offset + 2] || length !== 6 + 2 * bytes[offset + 2]) return false;
    offset = end;
    let hasEntropy = false;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        hasEntropy = true;
        offset += 1;
        continue;
      }
      const start = offset++;
      while (bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return false;
      const next = bytes[offset];
      if (next === 0x00 || next === 0x01 || (next >= 0xd0 && next <= 0xd7)) {
        if (next === 0x00) hasEntropy = true;
        offset += 1;
        continue;
      }
      offset = start;
      break;
    }
    if (!hasEntropy) return false;
    hasScan = true;
  }
  return false;
};

export const isJpegContainer = (bytes) => scanJpeg(bytes);

export const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const boundedDimensions = ([width, height]) => width > 0 && height > 0 && width <= 4096 && height <= 4096;
const fourCC = (bytes, offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
const uint24 = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);

// Container/dimension validation, not entropy decoding. https://developers.google.com/speed/webp/docs/riff_container
const webpDimensions = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || fourCC(bytes, 0) !== 'RIFF' || fourCC(bytes, 8) !== 'WEBP' || view.getUint32(4, true) !== bytes.length - 8) return null;
  const imageDimensions = (type, offset, length) => {
    if (type === 'VP8L' && length > 5 && bytes[offset] === 0x2f && (bytes[offset + 4] >> 5) === 0) {
      const bits = view.getUint32(offset + 1, true);
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
    if (type === 'VP8 ' && length > 10 && !(bytes[offset] & 1) && (bytes[offset] & 0x10)
      && bytes[offset + 3] === 0x9d && bytes[offset + 4] === 1 && bytes[offset + 5] === 0x2a) {
      return [view.getUint16(offset + 6, true) & 0x3fff, view.getUint16(offset + 8, true) & 0x3fff];
    }
    return null;
  };
  const chunks = (start, end) => {
    const result = [];
    for (let offset = start; offset < end;) {
      if (offset + 8 > end || result.length >= 1024) return null;
      const type = fourCC(bytes, offset);
      const length = view.getUint32(offset + 4, true);
      const next = offset + 8 + length + (length % 2);
      if (next > end || (length % 2 && bytes[next - 1] !== 0)) return null;
      result.push({ type, offset: offset + 8, length });
      offset = next;
    }
    return result;
  };
  const entries = chunks(12, bytes.length);
  if (!entries?.length) return null;
  let canvas = null;
  let animated = false;
  let images = 0;
  let animationHeader = false;
  for (const [index, entry] of entries.entries()) {
    const { type, offset, length } = entry;
    if (type === 'VP8X') {
      if (index !== 0 || length !== 10 || (bytes[offset] & 0xc1) || bytes[offset + 1] || bytes[offset + 2] || bytes[offset + 3]) return null;
      canvas = [uint24(bytes, offset + 4) + 1, uint24(bytes, offset + 7) + 1];
      if (!boundedDimensions(canvas)) return null;
      animated = Boolean(bytes[offset] & 2);
    } else if (type === 'ANIM') {
      if (!animated || animationHeader || images || length !== 6) return null;
      animationHeader = true;
    } else if (type === 'ANMF') {
      if (!animated || !animationHeader || length < 24 || (bytes[offset + 15] & 0xfc)) return null;
      const frame = [uint24(bytes, offset + 6) + 1, uint24(bytes, offset + 9) + 1];
      if (!boundedDimensions(frame) || uint24(bytes, offset) * 2 + frame[0] > canvas[0] || uint24(bytes, offset + 3) * 2 + frame[1] > canvas[1]) return null;
      const nested = chunks(offset + 16, offset + length);
      const frames = nested?.filter((part) => part.type === 'VP8 ' || part.type === 'VP8L');
      if (frames?.length !== 1 || nested.some((part) => !['ALPH','VP8 ','VP8L'].includes(part.type))) return null;
      const dimensions = imageDimensions(frames[0].type, frames[0].offset, frames[0].length);
      if (!dimensions || dimensions[0] !== frame[0] || dimensions[1] !== frame[1]) return null;
      images += 1;
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (animated || images) return null;
      const dimensions = imageDimensions(type, offset, length);
      if (!dimensions || !boundedDimensions(dimensions) || (canvas && (canvas[0] !== dimensions[0] || canvas[1] !== dimensions[1]))) return null;
      canvas = dimensions;
      images += 1;
    }
  }
  return images ? canvas : null;
};

export const validatedLogoContentType = (bytes, declared) => {
  if (!bytes.length || bytes.length > MAX_LOGO_BYTES) return null;
  const mime = String(declared || '').trim().toLowerCase().replace(/^image\/jpg$/, 'image/jpeg');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png' && isPngContainer(bytes)) {
    return boundedDimensions([view.getUint32(16), view.getUint32(20)]) ? mime : null;
  }
  if (mime === 'image/jpeg' && isJpegContainer(bytes)) {
    for (let offset = 2; offset + 4 < bytes.length;) {
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0x01) continue;
      const length = view.getUint16(offset);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4,0xc8,0xcc].includes(marker)) {
        return boundedDimensions([view.getUint16(offset + 5), view.getUint16(offset + 3)]) ? mime : null;
      }
      offset += length;
    }
  }
  if (mime === 'image/webp' && webpDimensions(bytes)) return mime;
  return null;
};

// Rebuild from the validated image container, retaining only data needed to display the image.
export const stripProofImageMetadata = (bytes, mime) => {
  if (validatedLogoContentType(bytes, mime) !== mime) return null;
  const parts = [];
  if (mime === "image/png") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    parts.push(bytes.subarray(0, 8));
    for (let offset = 8; offset < bytes.length;) {
      const end = offset + view.getUint32(offset) + 12;
      const type = fourCC(bytes, offset + 4);
      if (["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(type)) parts.push(bytes.subarray(offset, end));
      offset = end;
    }
  } else if (mime === "image/jpeg") {
    let start = 0;
    if (!scanJpeg(bytes, (offset, end, marker, payload) => {
      // A fixed-size Adobe APP14 segment supplies the JPEG color transform.
      if (marker === 0xee && end - payload === 12 &&
          String.fromCharCode(...bytes.subarray(payload, payload + 5)) === "Adobe") return;
      parts.push(bytes.subarray(start, offset));
      start = end;
    })) return null;
    parts.push(bytes.subarray(start));
  } else {
    return null;
  }

  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};
