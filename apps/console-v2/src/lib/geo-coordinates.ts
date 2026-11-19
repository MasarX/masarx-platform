export interface CoordinatePair {
  lat: number;
  lng: number;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function validCoordinatePair(lat: number | null, lng: number | null): CoordinatePair | null {
  if (lat == null || lng == null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bytesFromHex(value: string): Uint8Array | null {
  const hex = value.trim();
  if (hex.length < 42 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function coordinatePairFromWkbHex(value: string): CoordinatePair | null {
  const bytes = bytesFromHex(value);
  if (!bytes || bytes.length < 21) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = bytes[0] === 1;
  if (!littleEndian && bytes[0] !== 0) return null;
  const type = view.getUint32(1, littleEndian);
  if ((type & 0xffff) !== 1) return null;
  let offset = 5;
  if ((type & 0x20000000) !== 0) offset += 4;
  if (bytes.length < offset + 16) return null;
  const lng = view.getFloat64(offset, littleEndian);
  const lat = view.getFloat64(offset + 8, littleEndian);
  return validCoordinatePair(lat, lng);
}

function coordinatePairFromText(value: string): CoordinatePair | null {
  const text = value.trim();
  const wktMatch = /^(?:SRID=\d+;)?POINT\s*\(\s*([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)\s*\)$/i.exec(text);
  if (wktMatch) {
    return validCoordinatePair(numberFromUnknown(wktMatch[2]), numberFromUnknown(wktMatch[1]));
  }
  return coordinatePairFromWkbHex(text);
}

export function coordinatePairFromUnknown(value: unknown): CoordinatePair | null {
  if (typeof value === 'string') return coordinatePairFromText(value);
  const record = objectRecord(value);
  if (!Object.keys(record).length) return null;
  return validCoordinatePair(
    numberFromUnknown(record.lat ?? record.latitude ?? record.y),
    numberFromUnknown(record.lng ?? record.longitude ?? record.lon ?? record.x),
  );
}

function trimCoordinate(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, '');
}

export function formatCoordinatePair(value: unknown): string {
  const pair = coordinatePairFromUnknown(value);
  return pair ? `${trimCoordinate(pair.lat)}, ${trimCoordinate(pair.lng)}` : '';
}
