#!/usr/bin/env node
const fs = require('fs');
const zlib = require('zlib');

const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxEntries: 1024,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 128 * 1024 * 1024,
});

function resolveLimit(value, fallback, fail, code) {
  const resolved = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < 1) fail(code);
  return resolved;
}

function readZipArchive(zipBytes, options = {}) {
  const prefix = String(options.errorPrefix || 'zip_archive');
  const fail = (code) => {
    throw new Error(`${prefix}_${code}`);
  };
  const maxArchiveBytes = resolveLimit(options.maxArchiveBytes, DEFAULT_LIMITS.maxArchiveBytes, fail, 'archive_limit_invalid');
  const maxEntries = resolveLimit(options.maxEntries, DEFAULT_LIMITS.maxEntries, fail, 'entry_limit_invalid');
  const maxEntryBytes = resolveLimit(options.maxEntryUncompressedBytes, DEFAULT_LIMITS.maxEntryUncompressedBytes, fail, 'entry_size_limit_invalid');
  const maxTotalBytes = resolveLimit(options.maxTotalUncompressedBytes, DEFAULT_LIMITS.maxTotalUncompressedBytes, fail, 'total_size_limit_invalid');
  if (!Buffer.isBuffer(zipBytes) || zipBytes.length < 22 || zipBytes.length > maxArchiveBytes) fail('size_invalid');

  const decodeUtf8 = (bytes) => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail('utf8_invalid');
    }
    return '';
  };
  const inspectExtra = (bytes) => {
    let offset = 0;
    while (offset < bytes.length) {
      if (offset + 4 > bytes.length) fail('extra_invalid');
      const id = bytes.readUInt16LE(offset);
      const size = bytes.readUInt16LE(offset + 2);
      offset += 4;
      if (offset + size > bytes.length) fail('extra_invalid');
      if (id === 0x0001) fail('zip64_unsupported');
      offset += size;
    }
  };
  const safeAdd = (...values) => {
    const total = values.reduce((sum, value) => sum + Number(value), 0);
    if (!Number.isSafeInteger(total)) fail('size_invalid');
    return total;
  };

  const minimumEocdOffset = Math.max(0, zipBytes.length - 65_557);
  let eocdOffset = -1;
  for (let offset = zipBytes.length - 22; offset >= minimumEocdOffset; offset -= 1) {
    if (zipBytes.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) fail('eocd_invalid');
  const eocdCommentLength = zipBytes.readUInt16LE(eocdOffset + 20);
  if (safeAdd(eocdOffset, 22, eocdCommentLength) !== zipBytes.length) fail('eocd_invalid');
  decodeUtf8(zipBytes.subarray(eocdOffset + 22));
  if (eocdOffset >= 20 && zipBytes.readUInt32LE(eocdOffset - 20) === 0x07064b50) fail('zip64_unsupported');

  const diskNumber = zipBytes.readUInt16LE(eocdOffset + 4);
  const centralDisk = zipBytes.readUInt16LE(eocdOffset + 6);
  const diskEntries = zipBytes.readUInt16LE(eocdOffset + 8);
  const totalEntries = zipBytes.readUInt16LE(eocdOffset + 10);
  const centralSize = zipBytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = zipBytes.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) fail('multi_disk_unsupported');
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('zip64_unsupported');
  if (totalEntries < 1 || totalEntries > maxEntries) fail('entry_count_invalid');
  if (safeAdd(centralOffset, centralSize) !== eocdOffset) fail('central_directory_invalid');

  const metadata = [];
  const seenNames = new Set();
  let centralCursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (centralCursor + 46 > eocdOffset || zipBytes.readUInt32LE(centralCursor) !== 0x02014b50) fail('central_header_invalid');
    const flags = zipBytes.readUInt16LE(centralCursor + 8);
    const method = zipBytes.readUInt16LE(centralCursor + 10);
    const crc = zipBytes.readUInt32LE(centralCursor + 16);
    const compressedSize = zipBytes.readUInt32LE(centralCursor + 20);
    const uncompressedSize = zipBytes.readUInt32LE(centralCursor + 24);
    const nameLength = zipBytes.readUInt16LE(centralCursor + 28);
    const extraLength = zipBytes.readUInt16LE(centralCursor + 30);
    const commentLength = zipBytes.readUInt16LE(centralCursor + 32);
    const externalAttributes = zipBytes.readUInt32LE(centralCursor + 38);
    const localOffset = zipBytes.readUInt32LE(centralCursor + 42);
    const headerEnd = safeAdd(centralCursor, 46, nameLength, extraLength, commentLength);
    if (headerEnd > eocdOffset) fail('central_header_invalid');
    if ((flags & 0x0041) !== 0) fail('encrypted');
    if (method !== 0 && method !== 8) fail('compression_unsupported');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) fail('zip64_unsupported');
    if (uncompressedSize > maxEntryBytes || compressedSize > maxArchiveBytes) fail('entry_size_invalid');
    if (((externalAttributes >>> 16) & 0xf000) === 0xa000) fail('symlink');

    const nameBytes = zipBytes.subarray(centralCursor + 46, centralCursor + 46 + nameLength);
    const extraBytes = zipBytes.subarray(centralCursor + 46 + nameLength, centralCursor + 46 + nameLength + extraLength);
    const commentBytes = zipBytes.subarray(headerEnd - commentLength, headerEnd);
    inspectExtra(extraBytes);
    const name = decodeUtf8(nameBytes);
    decodeUtf8(commentBytes);
    const normalizedName = name.replace(/\\/g, '/');
    const isDirectory = normalizedName.endsWith('/');
    const segments = normalizedName.split('/');
    if (isDirectory) segments.pop();
    if (!normalizedName
        || normalizedName.startsWith('/')
        || /^[A-Za-z]:/.test(normalizedName)
        || normalizedName.includes('\0')
        || segments.some((segment) => !segment || segment === '.' || segment === '..')) fail('entry_invalid');
    if (seenNames.has(normalizedName)) fail('entry_duplicate');
    seenNames.add(normalizedName);
    if (isDirectory && (compressedSize !== 0 || uncompressedSize !== 0)) fail('directory_invalid');

    metadata.push({ name: normalizedName, isDirectory, flags, method, crc, compressedSize, uncompressedSize, localOffset, nameBytes });
    centralCursor = headerEnd;
  }
  if (centralCursor !== eocdOffset) fail('central_directory_invalid');

  const spans = [];
  const entries = [];
  let totalUncompressedBytes = 0;
  for (const entry of metadata) {
    const { name, isDirectory, flags, method, crc, compressedSize, uncompressedSize, localOffset, nameBytes } = entry;
    if (localOffset + 30 > centralOffset || zipBytes.readUInt32LE(localOffset) !== 0x04034b50) fail('local_header_invalid');
    const localFlags = zipBytes.readUInt16LE(localOffset + 6);
    const localMethod = zipBytes.readUInt16LE(localOffset + 8);
    const localCrc = zipBytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = zipBytes.readUInt32LE(localOffset + 18);
    const localUncompressedSize = zipBytes.readUInt32LE(localOffset + 22);
    const localNameLength = zipBytes.readUInt16LE(localOffset + 26);
    const localExtraLength = zipBytes.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localExtraStart = safeAdd(localNameStart, localNameLength);
    const dataOffset = safeAdd(localExtraStart, localExtraLength);
    const dataEnd = safeAdd(dataOffset, compressedSize);
    if (dataEnd > centralOffset || localFlags !== flags || localMethod !== method) fail('local_header_invalid');
    const localNameBytes = zipBytes.subarray(localNameStart, localExtraStart);
    if (!localNameBytes.equals(nameBytes)) fail('local_name_mismatch');
    decodeUtf8(localNameBytes);
    inspectExtra(zipBytes.subarray(localExtraStart, dataOffset));

    let spanEnd = dataEnd;
    if ((flags & 0x0008) !== 0) {
      const descriptorValues = (offset) => offset + 12 <= centralOffset
        ? {
            crc: zipBytes.readUInt32LE(offset),
            compressedSize: zipBytes.readUInt32LE(offset + 4),
            uncompressedSize: zipBytes.readUInt32LE(offset + 8),
          }
        : null;
      const signedDescriptor = dataEnd + 16 <= centralOffset && zipBytes.readUInt32LE(dataEnd) === 0x08074b50
        ? descriptorValues(dataEnd + 4)
        : null;
      const bareDescriptor = descriptorValues(dataEnd);
      const matches = (candidate) => candidate?.crc === crc
        && candidate.compressedSize === compressedSize
        && candidate.uncompressedSize === uncompressedSize;
      if (matches(signedDescriptor)) {
        spanEnd = dataEnd + 16;
      } else if (matches(bareDescriptor)) {
        spanEnd = dataEnd + 12;
      } else {
        const candidate = signedDescriptor || bareDescriptor;
        if (candidate?.compressedSize === compressedSize
            && candidate.uncompressedSize === uncompressedSize
            && candidate.crc !== crc) fail('crc_invalid');
        fail('data_descriptor_invalid');
      }
      if ((localCrc !== 0 && localCrc !== crc)
          || (localCompressedSize !== 0 && localCompressedSize !== compressedSize)
          || (localUncompressedSize !== 0 && localUncompressedSize !== uncompressedSize)) fail('local_header_invalid');
    } else if (localCrc !== crc || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize) {
      fail('local_header_invalid');
    }

    const compressed = zipBytes.subarray(dataOffset, dataEnd);
    let data;
    try {
      if (method === 0) {
        if (compressedSize !== uncompressedSize) fail('stored_size_invalid');
        data = Buffer.from(compressed);
      } else {
        data = zlib.inflateRawSync(compressed, { maxOutputLength: maxEntryBytes });
      }
    } catch (error) {
      if (String(error?.message || '').startsWith(prefix + '_')) throw error;
      fail('read_invalid');
    }
    if (data.length !== uncompressedSize) fail('read_invalid');
    if ((zlib.crc32(data) >>> 0) !== crc) fail('crc_invalid');
    totalUncompressedBytes = safeAdd(totalUncompressedBytes, data.length);
    if (totalUncompressedBytes > maxTotalBytes) fail('total_size_invalid');
    spans.push({ start: localOffset, end: spanEnd });
    entries.push({ name, isDirectory, data });
  }

  spans.sort((left, right) => left.start - right.start);
  for (let index = 1; index < spans.length; index += 1) {
    if (spans[index - 1].end > spans[index].start) fail('entry_overlap');
  }
  if (spans.some((span) => span.end > centralOffset)) fail('entry_overlap');
  return entries;
}

function readZipArchiveFile(zipPath, options = {}) {
  const stat = fs.lstatSync(zipPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${String(options.errorPrefix || 'zip_archive')}_file_invalid`);
  const maxArchiveBytes = options.maxArchiveBytes == null ? DEFAULT_LIMITS.maxArchiveBytes : Number(options.maxArchiveBytes);
  if (!Number.isSafeInteger(maxArchiveBytes) || maxArchiveBytes < 1 || stat.size > maxArchiveBytes) {
    throw new Error(`${String(options.errorPrefix || 'zip_archive')}_size_invalid`);
  }
  return readZipArchive(fs.readFileSync(zipPath), { ...options, maxArchiveBytes });
}

module.exports = {
  DEFAULT_LIMITS,
  readZipArchive,
  readZipArchiveFile,
};
