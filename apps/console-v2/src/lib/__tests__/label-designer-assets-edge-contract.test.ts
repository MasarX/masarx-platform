import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../../..');
const source = readFileSync(path.join(repoRoot, 'supabase/functions/label-designer-assets/index.ts'), 'utf8');

describe('label-designer-assets edge contract', () => {
  it('checks supported image bytes and declared MIME before storage upload', () => {
    const sniffIndex = source.indexOf('const detectedType = imageContentTypeFromBytes(bytes, contentType)');
    const invalidImageIndex = source.indexOf('"invalid_image"', sniffIndex);
    const mismatchIndex = source.indexOf('"image_mime_mismatch"', invalidImageIndex);
    const uploadIndex = source.indexOf('storageClient.storage.from(ASSET_BUCKET).upload', mismatchIndex);

    expect(source).toContain('isPngContainer(bytes)');
    expect(source).toContain('isJpegContainer(bytes)');
    expect(source).toContain('"image/webp"');
    expect(source).toContain('"application/octet-stream"');
    expect(sniffIndex).toBeGreaterThan(0);
    expect(invalidImageIndex).toBeGreaterThan(sniffIndex);
    expect(mismatchIndex).toBeGreaterThan(invalidImageIndex);
    expect(uploadIndex).toBeGreaterThan(mismatchIndex);
  });

  it('validates org-scoped designer asset paths before delete', () => {
    expect(source).toContain('mode === "delete"');
    expect(source).toContain('"forbidden_path"');
    expect(source).toContain('storageClient.storage.from(ASSET_BUCKET).remove([path])');

    const deleteIndex = source.indexOf('if (typed.mode === "delete")');
    const canonicalPathIndex = source.indexOf('const path = canonicalStorageKey(typed.path, orgId, { write: true });', deleteIndex);
    const pathGuardIndex = source.indexOf('if (!path?.startsWith(`${orgId}/${DESIGNER_DIR}/`))', canonicalPathIndex);
    const rejectionIndex = source.indexOf('return json(403, { ok: false, error: { code: "forbidden_path" } }', pathGuardIndex);
    const removeIndex = source.indexOf('storageClient.storage.from(ASSET_BUCKET).remove([path])', deleteIndex);

    expect(deleteIndex).toBeGreaterThan(0);
    expect(canonicalPathIndex).toBeGreaterThan(deleteIndex);
    expect(pathGuardIndex).toBeGreaterThan(canonicalPathIndex);
    expect(rejectionIndex).toBeGreaterThan(pathGuardIndex);
    expect(removeIndex).toBeGreaterThan(rejectionIndex);
  });
});
