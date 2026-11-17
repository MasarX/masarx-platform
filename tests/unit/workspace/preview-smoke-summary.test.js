const {
  buildPreviewSmokeSummary,
  buildMarkdown,
  expectedChecksForSurfaces,
  resolveRequiredSurfaces,
} = require('../../../scripts/ops/workspace/preview-smoke-summary');

describe('preview-smoke-summary', () => {
  test('expectedChecksForSurfaces maps required surfaces to smoke checks', () => {
    expect(expectedChecksForSurfaces(['db', 'console', 'portal', 'landing', 'docs', 'mobile_fieldops'])).toEqual([
      'workflow_intake_smoke',
      'ui_surface_smoke',
      'landing_smoke',
      'docs_smoke',
      'mobile_preview_state',
    ]);
  });

  test('resolveRequiredSurfaces falls back to manifest required_for_run markers', () => {
    const requiredSurfaces = resolveRequiredSurfaces({
      raw: '',
      manifest: {
        surfaces: {
          db: { required_for_run: '1' },
          console: { required_for_run: '1' },
          portal: { required_for_run: '1' },
          landing: { required_for_run: '0' },
        },
      },
    });

    expect(requiredSurfaces).toEqual(['db', 'console', 'portal']);
  });

  test('buildPreviewSmokeSummary reports complete coverage for required db+ui smoke', () => {
    const summary = buildPreviewSmokeSummary({
      manifest: {
        warnings: [],
        surfaces: {
          db: { status: 'prewarmed', required_for_run: '1' },
          console: { status: 'deployed', required_for_run: '1' },
          portal: { status: 'deployed', required_for_run: '1' },
        },
      },
      manifestPath: '.tmp/preview-manifests/worktree-worker.json',
      globalSmoke: {
        report_path: '.tmp/preview-manifests/worktree-worker.json.global-smoke.json',
        checks: [
          { check: 'workflow_intake_smoke', ok: true },
          { check: 'ui_surface_smoke', ok: true },
        ],
      },
      a2zReport: null,
      benchmarkReport: null,
      requiredSurfaces: 'db,console,portal',
      mode: 'preview',
      keepResources: false,
      runA2z: false,
    });

    expect(summary.coverage_status).toBe('complete');
    expect(summary.status).toBe('passed');
    expect(summary.failure_reasons).toEqual([]);
    expect(summary.partial_reasons).toEqual([]);
  });

  test('buildPreviewSmokeSummary reports partial coverage when required smoke checks are skipped', () => {
    const summary = buildPreviewSmokeSummary({
      manifest: {
        warnings: [],
        surfaces: {
          db: { status: 'prewarmed', required_for_run: '1' },
          console: { status: 'deployed', required_for_run: '1' },
          portal: { status: 'deployed', required_for_run: '1' },
        },
      },
      manifestPath: '.tmp/preview-manifests/worktree-worker.json',
      globalSmoke: {
        checks: [
          { check: 'workflow_intake_smoke', ok: true },
          { check: 'ui_surface_smoke', ok: true, skipped: true, reason: 'missing_console_or_portal_url' },
        ],
      },
      a2zReport: null,
      benchmarkReport: null,
      requiredSurfaces: 'db,console,portal',
      mode: 'preview',
      keepResources: true,
      runA2z: false,
    });

    expect(summary.coverage_status).toBe('partial');
    expect(summary.status).toBe('warning');
    expect(summary.partial_reasons).toContain('skipped_check:ui_surface_smoke:missing_console_or_portal_url');
  });

  test('buildPreviewSmokeSummary reports failed coverage when A-Z blockers are present', () => {
    const summary = buildPreviewSmokeSummary({
      manifest: {
        warnings: [],
        surfaces: {
          db: { status: 'prewarmed', required_for_run: '1' },
          console: { status: 'deployed', required_for_run: '1' },
          portal: { status: 'deployed', required_for_run: '1' },
        },
      },
      manifestPath: '.tmp/preview-manifests/worktree-worker.json',
      globalSmoke: {
        checks: [
          { check: 'workflow_intake_smoke', ok: true },
          { check: 'ui_surface_smoke', ok: true },
        ],
      },
      a2zReport: {
        blockers: ['demo-account-missing'],
        groups: {
          console: { status: 'blocked' },
        },
      },
      benchmarkReport: null,
      requiredSurfaces: 'db,console,portal',
      mode: 'preview',
      keepResources: false,
      runA2z: true,
    });

    expect(summary.coverage_status).toBe('failed');
    expect(summary.status).toBe('failed');
    expect(summary.failure_reasons).toEqual(expect.arrayContaining([
      'a2z_blocker:demo-account-missing',
      'a2z_group_failure',
    ]));
  });

  test('buildMarkdown renders coverage, surfaces, and smoke check tables', () => {
    const markdown = buildMarkdown({
      coverage_status: 'partial',
      mode: 'preview',
      required_surfaces: ['db', 'console', 'portal'],
      keep_resources: false,
      failure_reasons: [],
      partial_reasons: ['skipped_check:ui_surface_smoke:missing_console_or_portal_url'],
      surface_states: [
        { surface_id: 'db', raw_status: 'prewarmed', reason: '' },
        { surface_id: 'console', raw_status: 'deployed', reason: '' },
      ],
      checks: [
        { check: 'workflow_intake_smoke', status: 'passed', reason: '' },
        { check: 'ui_surface_smoke', status: 'skipped', reason: 'missing_console_or_portal_url' },
      ],
      a2z: {
        requested: false,
        status: 'not_requested',
        blockers: [],
        group_status_counts: {},
      },
    });

    expect(markdown).toContain('### Preview Smoke Summary');
    expect(markdown).toContain('Coverage: `partial`');
    expect(markdown).toContain('#### Surface States');
    expect(markdown).toContain('#### Smoke Checks');
  });
});
