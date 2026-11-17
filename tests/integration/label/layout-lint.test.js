const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const templatePath = path.join(__dirname, '..', '..', '..', 'supabase', 'templates', 'waybill_v1_5.json');
const templateJson = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
const template = templateJson.templates.shipping;

const samplePayload = {
  payment_term_label: 'Prepaid',
  created_at_local: '2025-12-15 12:34:56',
  service_level_label: 'delivery',
  barcode_value: 'LBLE2EA950E790',
  tracking_number: 'LBLE2EA950E790:1',
  sender_phone: '+12025550123',
  sender_name: 'Sender With Very Long Name That Needs Truncation',
  origin_line1: 'Riyadh, Riyadh, Saudi Arabia, District With Extra Words',
  origin_summary: 'Riyadh, Riyadh, SA',
  recipient_phone: '+12025550123',
  recipient_name: 'Recipient Name With Many Words To Force Max Width',
  destination_line1: 'Riyadh, Riyadh, Saudi Arabia, Extra Details For Stress',
  destination_summary: 'Riyadh, Riyadh, SA',
  destination_city_code: 'RIY',
  weight_label: '--',
  reference_number: 'LBLE2EA950E790',
  cod_label: '0 SAR',
  bundle_label: '1',
  shipment_metadata: 'Item list content goes here and may be long',
  special_instructions: 'Fragile; handle with care; keep upright during transit',
};

const resolvePathValue = (root, pathStr) => {
  if (!root || !pathStr || pathStr.trim().length === 0) return undefined;
  const iterator = pathStr.matchAll(/([^[.\]]+)|\[(\d+)\]/g);
  let current = root;
  for (const match of iterator) {
    if (current === undefined || current === null) return undefined;
    if (match[1] !== undefined) {
      current = current?.[match[1]];
    } else if (match[2] !== undefined) {
      const index = Number(match[2]);
      current = Array.isArray(current) ? current[index] : undefined;
    }
  }
  return current;
};

const stringifyValue = (value, fallback) => {
  if (value === undefined || value === null) return fallback ?? '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return fallback ?? '';
  }
};

const truncateToWidth = (text, font, size, maxWidth) => {
  if (!maxWidth || maxWidth <= 0) return text;
  const width = font.widthOfTextAtSize(text, size);
  if (width <= maxWidth) return text;
  const ellipsis = '...';
  for (let i = text.length - 1; i >= 0; i--) {
    const candidate = text.slice(0, i) + ellipsis;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth - 1) {
      return candidate;
    }
  }
  return ellipsis;
};

const CODE128_PATTERNS = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100', '10011001000',
  '10011000100', '10001100100', '11001001000', '11001000100', '11000100100', '10110011100', '10011011100',
  '10011001110', '10111001100', '10011101100', '10011100110', '11001110010', '11001011100', '11001001110',
  '11011100100', '11001110100', '11101101110', '11101001100', '11100101100', '11100100110', '11101100100',
  '11100110100', '11100110010', '11011011000', '11011000110', '11000110110', '10100011000', '10001011000',
  '10001000110', '10110001000', '10001101000', '10001100010', '11010001000', '11000101000', '11000100010',
  '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110', '11101110110',
  '11010001110', '11000101110', '11011101000', '11011100010', '11011101110', '11101011000', '11101000110',
  '11100010110', '11101101000', '11101100010', '11100011010', '11101111010', '11001000010', '11110001010',
  '10100110000', '10100001100', '10010110000', '10010000110', '10000101100', '10000100110', '10110010000',
  '10110000100', '10011010000', '10011000010', '10000110100', '10000110010', '11000010010', '11001010000',
  '11110111010', '11000010100', '10001111010', '10100111100', '10010111100', '10010011110', '10111100100',
  '10011110100', '10011110010', '11110100100', '11110010100', '11110010010', '11011011110', '11011110110',
  '11110110110', '10101111000', '10100011110', '10001011110', '10111101000', '10111100010', '11110101000',
  '11110100010', '10111011110', '10111101110', '11101011110', '11110101110', '11010000100', '11010010000',
  '11010011100', '1100011101011',
];

const encodeCode128B = (value) => {
  const codes = [104];
  let checksum = 104;
  for (let i = 0; i < value.length; i++) {
    const codePoint = value.charCodeAt(i);
    if (codePoint < 32 || codePoint > 126) throw new Error(`Unsupported Code128-B character: ${value[i]}`);
    const code = codePoint - 32;
    codes.push(code);
    checksum += code * (i + 1);
  }
  const checksumCode = checksum % 103;
  codes.push(checksumCode);
  codes.push(106);
  const patterns = codes.map((c) => {
    const pattern = CODE128_PATTERNS[c];
    if (!pattern) throw new Error(`Invalid Code128 pattern for code ${c}`);
    return pattern;
  });
  const patternString = patterns.join('');
  const moduleCount = patternString.length + 20;
  return { pattern: patternString, modules: moduleCount };
};

const overlaps = (a, b) => !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

const validateLayout = async () => {
  const pageCfg = template.page ?? {};
  const pageWidth = Math.max(72, Math.round((pageCfg.width_inch ?? 4) * 72));
  const pageHeight = Math.max(72, Math.round((pageCfg.height_inch ?? 6) * 72));
  const pdfDoc = await PDFDocument.create();
  const fontCache = new Map();
  const selectFont = async (fontName) => {
    const normalized = (fontName ?? 'helvetica').toLowerCase();
    if (!fontCache.has(normalized)) {
      switch (normalized) {
        case 'helvetica-bold':
        case 'helvetica_bold':
        case 'bold':
          fontCache.set(normalized, await pdfDoc.embedFont(StandardFonts.HelveticaBold));
          break;
        case 'courier':
        case 'barcode':
          fontCache.set(normalized, await pdfDoc.embedFont(StandardFonts.Courier));
          break;
        case 'times':
        case 'times-roman':
          fontCache.set(normalized, await pdfDoc.embedFont(StandardFonts.TimesRoman));
          break;
        default:
          fontCache.set(normalized, await pdfDoc.embedFont(StandardFonts.Helvetica));
          break;
      }
    }
    return fontCache.get(normalized);
  };

  const boxes = [];
  const collidable = new Set(['text', 'barcode', 'image']);

  for (const block of template.blocks) {
    if (!block || typeof block !== 'object') continue;
    const x = typeof block.x === 'number' ? block.x : 0;
    const y = typeof block.y === 'number' ? block.y : 0;

    if (block.type === 'text') {
      const rawValue = resolvePathValue(samplePayload, block.value_path) ?? resolvePathValue({ job: {} }, block.value_path);
      const textRaw = stringifyValue(rawValue, block.fallback);
      if (!textRaw) continue;
      const font = await selectFont(block.font);
      const size = block.font_size ?? 12;
      const textValue = truncateToWidth(textRaw, font, size, block.max_width);
      if (!textValue) continue;
      const textWidth = font.widthOfTextAtSize(textValue, size);
      let drawX = x;
      if (block.align === 'center') drawX = x - textWidth / 2;
      else if (block.align === 'right') drawX = x - textWidth;
      const textHeight = size + 2;
      if (drawX < 0 || y < 0 || drawX + textWidth > pageWidth || y + textHeight > pageHeight) {
        throw new Error(`Text out of bounds: ${block.value_path ?? block.fallback}`);
      }
      if (collidable.has('text')) {
        const candidate = {
          x: drawX,
          y,
          width: textWidth,
          height: textHeight,
          blockType: 'text',
          blockLabel: block.value_path ?? block.fallback ?? 'text',
        };
        for (const existing of boxes) {
          if (overlaps(existing, candidate)) {
            throw new Error(`Collision between ${candidate.blockLabel} and ${existing.blockLabel ?? existing.blockType}`);
          }
        }
        boxes.push(candidate);
      }
      continue;
    }

    if (block.type === 'barcode') {
      const rawValue = resolvePathValue(samplePayload, block.value_path) ?? resolvePathValue({ job: {} }, block.value_path);
      const value = stringifyValue(rawValue, block.fallback);
      if (!value) continue;
      const requestedModule = block.module_width && block.module_width > 0 ? block.module_width : 1.1;
      const barHeight = block.height && block.height > 0 ? block.height : 56;
      const humanReadable = block.human_readable !== false;
      const { pattern, modules } = encodeCode128B(value);
      let moduleWidth = requestedModule;
      if (block.max_width && block.max_width > 0) {
        moduleWidth = Math.min(requestedModule, block.max_width / modules);
        moduleWidth = Math.max(moduleWidth, 0.35);
      }
      const totalWidth = modules * moduleWidth;
      if (block.max_width && block.max_width > 0 && totalWidth > block.max_width + 0.1) {
        throw new Error(`Barcode width exceeds max_width for ${block.value_path ?? 'barcode'}`);
      }
      let startX = x;
      if (block.align === 'center') startX = x - totalWidth / 2;
      else if (block.align === 'right') startX = x - totalWidth;
      const hrSize = humanReadable ? (block.font_size ?? 11) : 0;
      const hrOffset = humanReadable ? hrSize + 4 : 0;
      const boxY = y - hrOffset;
      const boxHeight = barHeight + hrOffset;
      if (startX < 0 || boxY < 0 || startX + totalWidth > pageWidth || boxY + boxHeight > pageHeight) {
        throw new Error(`Barcode out of bounds for ${block.value_path ?? 'barcode'}`);
      }
      if (collidable.has('barcode')) {
        const candidate = {
          x: startX,
          y: boxY,
          width: totalWidth,
          height: boxHeight,
          blockType: 'barcode',
          blockLabel: block.value_path ?? 'barcode',
        };
        for (const existing of boxes) {
          if (overlaps(existing, candidate)) {
            throw new Error(`Collision between ${candidate.blockLabel} and ${existing.blockLabel ?? existing.blockType}`);
          }
        }
        boxes.push(candidate);
      }
      continue;
    }

    if (block.type === 'image') {
      const width = block.width ?? 0;
      const height = block.height ?? 0;
      if (x < 0 || y < 0 || x + width > pageWidth || y + height > pageHeight) {
        throw new Error(`Image out of bounds for ${block.asset_ref ?? block.value_path ?? 'image'}`);
      }
      if (collidable.has('image')) {
        const candidate = {
          x,
          y,
          width,
          height,
          blockType: 'image',
          blockLabel: block.asset_ref ?? block.value_path ?? 'image',
        };
        for (const existing of boxes) {
          if (overlaps(existing, candidate)) {
            throw new Error(`Collision between ${candidate.blockLabel} and ${existing.blockLabel ?? existing.blockType}`);
          }
        }
        boxes.push(candidate);
      }
      continue;
    }

    if (block.type === 'line') {
      const x2 = typeof block.width === 'number' ? block.width : x;
      const y2 = typeof block.height === 'number' ? block.height : y;
      if (Math.min(x, x2) < 0 || Math.min(y, y2) < 0 || Math.max(x, x2) > pageWidth || Math.max(y, y2) > pageHeight) {
        throw new Error('Line out of bounds');
      }
      continue;
    }

    if (block.type === 'rect') {
      const width = block.width ?? 0;
      const height = block.height ?? 0;
      if (x < 0 || y < 0 || x + width > pageWidth || y + height > pageHeight) {
        throw new Error('Rectangle out of bounds');
      }
    }
  }

  expect(boxes.length).toBeGreaterThan(0);
};

describe('Label layout validation', () => {
  test('waybill 4x6 default template is bounded and collision-free', async () => {
    await validateLayout();
  });
});
