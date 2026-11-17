const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  applyMaterializedOwnershipToManifest,
  buildMaterializedOwnership,
  persistMaterializedOwnership,
  readMaterializedOwnership,
} = require('../../../scripts/ops/workspace/preview-ownership');

describe('preview workspace ownership', () => {
  test('binds branch generation lineage to exact provider identity and run attempt', () => {
    const base = {
      workspace_mode: 'branch',
      project_name: 'wk-masarx-pr-3286',
      project_ref: 'abcdefghijklmnopqrst',
      branch_id: 'branch-generation-one',
      branch_parent_ref: 'tsruxlpethmpzoxdkvto',
      active_family_generation: 1,
      run_id: '29321613154',
      run_attempt: '1',
      materialized_at: '2026-07-14T09:24:21.000Z',
    };
    const first = buildMaterializedOwnership(base);
    const same = buildMaterializedOwnership({ ...base, materialized_at: '2026-07-14T09:25:00.000Z' });
    const nextAttempt = buildMaterializedOwnership({ ...base, run_attempt: '2' });
    const sibling = buildMaterializedOwnership({
      ...base,
      project_ref: 'bcdefghijklmnopqrstu',
      branch_id: 'branch-generation-two',
      active_family_generation: 2,
    });

    expect(first.generation_token).toBe(same.generation_token);
    expect(nextAttempt.generation_token).not.toBe(first.generation_token);
    expect(sibling.generation_token).not.toBe(first.generation_token);
  });

  test('persists atomically and projects exact ownership into the manifest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-ownership-'));
    const filePath = path.join(dir, 'ownership.json');
    try {
      const ownership = persistMaterializedOwnership(filePath, {
        workspace_mode: 'project',
        project_name: 'wk-masarx-pr-3286-r-new',
        project_ref: 'abcdefghijklmnopqrst',
        active_family_generation: 2,
        run_id: '29321613154',
        run_attempt: '1',
      });
      const manifest = { surfaces: {} };
      applyMaterializedOwnershipToManifest(manifest, readMaterializedOwnership(filePath));
      expect(manifest.workspace_ownership).toEqual(ownership);
      expect(manifest.active_family_generation).toBe(2);
      expect(manifest.surfaces.db).toEqual(expect.objectContaining({
        project_name: 'wk-masarx-pr-3286-r-new',
        project_ref: 'abcdefghijklmnopqrst',
        workspace_mode: 'project',
        ownership_generation_token: ownership.generation_token,
      }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses shared parent projects and incomplete branch identities', () => {
    expect(() => buildMaterializedOwnership({
      workspace_mode: 'project',
      project_name: 'MasarX-DEV',
      project_ref: 'abcdefghijklmnopqrst',
    })).toThrow('Refusing non-preview workspace ownership');
    expect(() => buildMaterializedOwnership({
      workspace_mode: 'branch',
      project_name: 'wk-masarx-pr-3286',
      project_ref: 'abcdefghijklmnopqrst',
    })).toThrow('requires exact branch_id and branch_parent_ref');
  });
});
