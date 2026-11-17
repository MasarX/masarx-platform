const crypto = require('crypto');
const {
  assertOwnedCurrentSupabaseConfig,
  assertRegularNoLinkFile,
} = require('../../../scripts/ops/workspace/supabase-config-overlay-admission');
const { resolveWorkspaceProjectId } = require('../../../scripts/ops/workspace/local-config');
const WORKSPACE = 'wk-overlay-admission';
const PROJECT = resolveWorkspaceProjectId(WORKSPACE);
const PORTS = { api: 55121, db: 55122, studio: 55123, analytics: 55127 };
function overlayToml(extra = '') {
  return [
    '# AUTO-OVERLAY-BEGIN: do not commit this file; use local:stop to restore baseline',
    `project_id = "${PROJECT}"`,
    '[api]', `port = ${PORTS.api}`, '[db]', `port = ${PORTS.db}`,
    '[studio]', `port = ${PORTS.studio}`, '[analytics]', `port = ${PORTS.analytics}`,
    extra,
    `# AUTO-OVERLAY-END workspace=${WORKSPACE} ports=api:${PORTS.api},db:${PORTS.db},studio:${PORTS.studio},analytics:${PORTS.analytics}`,
    '',
  ].join('\n');
}
function ownedInput(current = Buffer.from(overlayToml())) {
  return { current, currentBlob: 'current', frozenBlob: 'frozen', identity: {
    workspace_id: WORKSPACE, project_id: PROJECT, ports: PORTS,
    overlay_binding: {
      before: { sha256: 'a'.repeat(64), ports: PORTS },
      after: { sha256: crypto.createHash('sha256').update(current).digest('hex'), ports: PORTS },
    },
  } };
}
describe('owned Supabase config overlay admission', () => {
  test('accepts a marker-free frozen blob without runtime metadata', () => {
    const current = Buffer.from('project_id = "409f56ef-eecb-4a2a-aec1-b9c3682af6f5"\n');
    expect(assertOwnedCurrentSupabaseConfig({ current, currentBlob: 'same', frozenBlob: 'same', identity: null }))
      .toEqual({ kind: 'marker-free-frozen-blob',
        current_sha256: crypto.createHash('sha256').update(current).digest('hex') });
  });
  test('accepts only the exact owned workspace and port overlay', () => {
    expect(assertOwnedCurrentSupabaseConfig(ownedInput())).toEqual(expect.objectContaining({
      kind: 'owned-overlay', current_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });
  test.each([
    ['port drift', (input) => { input.identity.ports = { ...PORTS, api: 55999 }; }],
    ['missing binding', (input) => { delete input.identity.overlay_binding; }],
    ['invalid binding', (input) => { input.identity.overlay_binding.after.sha256 = 'invalid'; }],
    ['interior drift', (input) => { input.current = Buffer.from(overlayToml('# unrelated edit')); }],
    ['duplicate marker', (input) => {
      input.current = Buffer.from(`${input.current.toString('utf8')}# AUTO-OVERLAY-BEGIN: do not commit this file; use local:stop to restore baseline\n`);
    }],
  ])('rejects %s', (_label, mutate) => {
    const input = ownedInput(); mutate(input);
    expect(() => assertOwnedCurrentSupabaseConfig(input)).toThrow();
  });
  test('rejects a linked or reparse-point config before reading content', () => {
    expect(() => assertRegularNoLinkFile('/repo', '/repo/supabase/config.toml', 'config', {
      existsSync: () => true,
      lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => true }),
    })).toThrow(/link/i);
  });
});
