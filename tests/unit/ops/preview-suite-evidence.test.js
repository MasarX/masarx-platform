const fs = require('fs');
const path = require('path');

const {
  buildPreviewSuiteEvidence,
  derivePreviewSuiteSignals,
  normalizeSuiteStatus,
  validatePreviewSuiteEvidence,
} = require('../../../scripts/ops/ci/preview-suite-evidence');

describe('preview-suite-evidence', () => {
  const tmpRoot = path.join(process.cwd(), '.tmp', 'tests');
  let tmpDir = '';

  beforeEach(() => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'preview-suite-evidence-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('normalizeSuiteStatus maps workflow outcomes to contract statuses', () => {
    expect(normalizeSuiteStatus('success')).toBe('passed');
    expect(normalizeSuiteStatus('failure')).toBe('failed');
    expect(normalizeSuiteStatus('cancelled')).toBe('failed');
    expect(normalizeSuiteStatus('skipped')).toBe('skipped');
  });

  test('derivePreviewSuiteSignals classifies hosted UI failures from logs', () => {
    const signals = derivePreviewSuiteSignals({
      suiteId: 'ui',
      summaryEntries: [],
      logEntries: [
        {
          path: 'verify-ui-gate.log',
          text: 'Expected console resource ready state, got console-auth-required',
        },
      ],
    });

    expect(signals.failureClass).toBe('auth-required');
  });

  test('buildPreviewSuiteEvidence prefers structured UI summary evidence when available', () => {
    const summaryPath = path.join(tmpDir, 'verify-cloud-ui-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
      status: 'failed',
      failure_class: 'auth-required',
      ui_state: 'auth-required',
      failed_step: 'test:e2e (gate; projects=console)',
    }, null, 2));
    const logPath = path.join(tmpDir, 'verify-ui-gate.log');
    fs.writeFileSync(logPath, 'generic ui log');

    const evidence = buildPreviewSuiteEvidence({
      workflowGroup: 'reviewer_gate',
      suiteId: 'ui',
      sha: 'd'.repeat(40),
      previewId: '321',
      required: true,
      stepOutcome: 'failure',
      summaryFiles: [summaryPath],
      logFiles: [logPath],
    });

    expect(evidence.status).toBe('failed');
    expect(evidence.failure_class).toBe('auth-required');
    expect(evidence.summary_files).toContain(summaryPath);
  });

  test('buildPreviewSuiteEvidence derives mobile failure class from strict summary output', () => {
    const summaryPath = path.join(tmpDir, 'mobile-strict-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
      status: 'failed',
      failed_step: 'fieldops:store:preflight',
      failure_class: 'store-preflight',
    }, null, 2));
    const logPath = path.join(tmpDir, 'fieldops-typecheck.log');
    fs.writeFileSync(logPath, 'typecheck log');

    const evidence = buildPreviewSuiteEvidence({
      workflowGroup: 'release_verify',
      suiteId: 'mobile',
      sha: 'a'.repeat(40),
      previewId: '123',
      required: true,
      stepOutcome: 'failure',
      summaryFiles: [summaryPath],
      logFiles: [logPath],
    });

    expect(evidence.status).toBe('failed');
    expect(evidence.failure_class).toBe('store-preflight');
    expect(evidence.summary_files).toContain(summaryPath);
  });

  test('buildPreviewSuiteEvidence fails closed when a passing suite is missing requested evidence files', () => {
    const evidence = buildPreviewSuiteEvidence({
      workflowGroup: 'reviewer_gate',
      suiteId: 'core',
      sha: 'b'.repeat(40),
      previewId: '456',
      required: true,
      stepOutcome: 'success',
      summaryFiles: [path.join(tmpDir, 'missing-summary.json')],
      logFiles: [path.join(tmpDir, 'missing-log.log')],
    });

    expect(evidence.status).toBe('failed');
    expect(evidence.failure_class).toBe('missing-evidence-file');
    expect(evidence.missing_files).toHaveLength(2);
  });

  test('validatePreviewSuiteEvidence enforces required suite success and silent skip zero', () => {
    const ok = validatePreviewSuiteEvidence({
      workflow_group: 'reviewer_gate',
      suite_id: 'global_smoke',
      sha: 'c'.repeat(40),
      preview_id: '789',
      authoritative_owner: `reviewer_gate:global_smoke:${'c'.repeat(40)}`,
      status: 'passed',
      verify_success: true,
      silent_skip_count: 0,
      missing_files: [],
    }, {
      workflowGroup: 'reviewer_gate',
      suiteId: 'global_smoke',
      sha: 'c'.repeat(40),
      previewId: '789',
      required: true,
    });
    expect(ok.ok).toBe(true);

    const failed = validatePreviewSuiteEvidence({
      workflow_group: 'reviewer_gate',
      suite_id: 'global_smoke',
      sha: 'c'.repeat(40),
      preview_id: '789',
      authoritative_owner: `reviewer_gate:global_smoke:${'c'.repeat(40)}`,
      status: 'failed',
      verify_success: false,
      silent_skip_count: 1,
      missing_files: ['report.json'],
    }, {
      workflowGroup: 'reviewer_gate',
      suiteId: 'global_smoke',
      sha: 'c'.repeat(40),
      previewId: '789',
      required: true,
    });

    expect(failed.ok).toBe(false);
    expect(failed.errors.join('\n')).toContain('status must be passed for required suite');
    expect(failed.errors.join('\n')).toContain('silent_skip_count must be 0');
    expect(failed.errors.join('\n')).toContain('missing required evidence files');
  });
});
