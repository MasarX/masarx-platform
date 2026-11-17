const {
  buildNightlyDevHeavySummary,
  formatMarkdown,
} = require('../../../scripts/ops/ci/nightly-dev-heavy-summary');

describe('nightly-dev-heavy-summary', () => {
  test('buildNightlyDevHeavySummary marks failed jobs and overall status', () => {
    const summary = buildNightlyDevHeavySummary({
      repo: 'MasarX/MasarX',
      ref: 'dev',
      runId: '123',
      runUrl: 'https://github.com/MasarX/MasarX/actions/runs/123',
      core: { result: 'success' },
      ui: { result: 'failure', failureClass: 'ui_assertion_failed' },
      landing: { result: 'success' },
      mobile: { result: 'cancelled' },
    });

    expect(summary.status).toBe('failed');
    expect(summary.failures).toEqual([
      expect.objectContaining({ job_id: 'ui', failure_class: 'ui_assertion_failed' }),
      expect.objectContaining({ job_id: 'mobile', failure_class: 'mobile_cancelled' }),
    ]);
  });

  test('formatMarkdown renders the current job matrix', () => {
    const markdown = formatMarkdown(buildNightlyDevHeavySummary({
      repo: 'MasarX/MasarX',
      ref: 'dev',
      runId: '456',
      core: { result: 'success' },
      ui: { result: 'success' },
      landing: { result: 'success' },
      mobile: { result: 'success' },
    }));

    expect(markdown).toContain('Nightly Dev Heavy');
    expect(markdown).toContain('`core`: `success`');
    expect(markdown).toContain('`mobile`: `success`');
  });
});
