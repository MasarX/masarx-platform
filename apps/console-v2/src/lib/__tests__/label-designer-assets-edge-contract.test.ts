import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../../..');
const source = readFileSync(path.join(repoRoot, 'supabase/functions/label-designer-assets/index.ts'), 'utf8');

describe('label-designer-assets edge contract', () => {
  it('accepts supported or unspecified image content types before storage upload', () => {
    expect(source).toContain('normalizeImageContentType');
    expect(source).toContain('isSupportedImageContentType');
    expect(source).toContain('isUnspecifiedContentType');
    expect(source).toContain('"application/octet-stream"');
    expect(source).toContain('"image/png"');
    expect(source).toContain('"image/jpeg"');
    expect(source).toContain('"image/webp"');
    expect(source).toContain('"unsupported_asset_type"');

    const contentTypeGuardIndex = source.indexOf('!isUnspecifiedContentType(requestedContentType)');
    const uploadIndex = source.indexOf('storageClient.storage.from(ASSET_BUCKET).upload');

    expect(contentTypeGuardIndex).toBeGreaterThan(0);
    expect(uploadIndex).toBeGreaterThan(contentTypeGuardIndex);
  });

  it('sniffs uploaded image bytes and fails mismatches before storage upload', () => {
    expect(source).toContain('detectImageContentType');
    expect(source).toContain('0x89');
    expect(source).toContain('0xff');
    expect(source).toContain('0x52');
    expect(source).toContain('"unsupported_asset_bytes"');
    expect(source).toContain('"asset_type_mismatch"');

    const sniffIndex = source.indexOf('const detectedContentType = detectImageContentType(bytes)');
    const mismatchIndex = source.indexOf('detectedContentType !== requestedContentType');
    const uploadIndex = source.indexOf('storageClient.storage.from(ASSET_BUCKET).upload');

    expect(sniffIndex).toBeGreaterThan(0);
    expect(mismatchIndex).toBeGreaterThan(sniffIndex);
    expect(uploadIndex).toBeGreaterThan(mismatchIndex);
  });

  it('validates org-scoped designer asset paths before delete', () => {
    expect(source).toContain('mode === "delete"');
    expect(source).toContain('"forbidden_path"');
    expect(source).toContain('storageClient.storage.from(ASSET_BUCKET).remove([path])');

    const deleteIndex = source.indexOf('if (typed.mode === "delete")');
    const pathGuardIndex = source.indexOf('if (!assertOrgPath(orgId, path))', deleteIndex);
    const removeIndex = source.indexOf('storageClient.storage.from(ASSET_BUCKET).remove([path])', deleteIndex);

    expect(deleteIndex).toBeGreaterThan(0);
    expect(pathGuardIndex).toBeGreaterThan(deleteIndex);
    expect(removeIndex).toBeGreaterThan(pathGuardIndex);
  });
});
