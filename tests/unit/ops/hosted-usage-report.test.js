const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs,
  normalizeCell,
  normalizeHeader,
  parseCsv,
  collectReport,
  resolveAlertBand,
} = require('../../../scripts/ops/ci/hosted-usage-report');

describe('hosted-usage-report', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('parseArgs applies defaults for included minutes, top rows, and format', () => {
    const parsed = parseArgs([
      '--workflow-csv',
      'workflow.csv',
      '--job-csv',
      'jobs.csv',
      '--from',
      '2026-03-01',
      '--to',
      '2026-03-15',
    ], new Date('2026-03-15T00:00:00.000Z'));

    expect(parsed).toEqual({
      summaryCsv: '',
      workflowCsv: 'workflow.csv',
      jobCsv: 'jobs.csv',
      from: '2026-03-01',
      to: '2026-03-15',
      includedMinutes: 50000,
      top: 10,
      format: 'json',
    });
  });

  test('normalizes GitHub export headers/cells and parses quoted CSV rows', () => {
    expect(normalizeHeader("'Total minutes")).toBe('total_minutes');
    expect(normalizeCell('"""\'hosted"""')).toBe('hosted');
    expect(parseCsv('"""\'Runner type""","""\'Total minutes"""\n"""\'hosted""",71916\n')).toEqual([
      ['Runner type', 'Total minutes'],
      ['hosted', '71916'],
    ]);
  });

  test('collectReport summarizes top workflows/jobs and projects month-end hosted usage', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-usage-report-'));
    tempDirs.push(tempDir);

    const summaryCsv = path.join(tempDir, 'summary.csv');
    const workflowCsv = path.join(tempDir, 'workflow.csv');
    const jobCsv = path.join(tempDir, 'jobs.csv');

    fs.writeFileSync(summaryCsv, [
      '"""\'Runner type""","""\'Total minutes""","""\'Workflow runs""","""\'Workflows"""',
      '"""\'hosted""",71916,24859,69',
    ].join('\n'));
    fs.writeFileSync(workflowCsv, [
      '"""\'Workflow""","""\'Source repository""","""\'Total minutes""","""\'Workflow runs""","""\'Jobs""","""\'Runner type""","""\'Runtime OS"""',
      '"""\'reviewer-gate-pr.yml""","""\'MasarX""",21812,1615,1,"""\'hosted""","""\'linux"""',
      '"""\'ready-pr-automerge.yml""","""\'MasarX""",4590,3818,1,"""\'hosted""","""\'linux"""',
    ].join('\n'));
    fs.writeFileSync(jobCsv, [
      '"""\'Job""","""\'Workflow""","""\'Source repository""","""\'Total minutes""","""\'Job runs""","""\'Runner type""","""\'Runner labels"""',
      '"""\'reviewer_gate""","""\'reviewer-gate-pr.yml""","""\'MasarX""",21812,1615,"""\'hosted""","""\'ubuntu-latest"""',
      '"""\'auto_enqueue""","""\'ready-pr-automerge.yml""","""\'MasarX""",4590,3818,"""\'hosted""","""\'ubuntu-latest"""',
    ].join('\n'));

    const report = collectReport({
      summaryCsv,
      workflowCsv,
      jobCsv,
      from: '2026-03-01',
      to: '2026-03-15',
      includedMinutes: 50000,
      top: 2,
    });

    expect(report.total_minutes).toBe(71916);
    expect(report.window.elapsed_days).toBe(15);
    expect(report.projected_month_end_minutes).toBe(148626.4);
    expect(report.current_pool_utilization_percent).toBe(143.83);
    expect(report.projected_pool_utilization_percent).toBe(297.25);
    expect(report.alert_band).toBe('100');
    expect(report.top_workflows).toEqual([
      expect.objectContaining({ name: 'reviewer-gate-pr.yml', total_minutes: 21812, share_percent: 30.33 }),
      expect.objectContaining({ name: 'ready-pr-automerge.yml', total_minutes: 4590, share_percent: 6.38 }),
    ]);
    expect(report.top_jobs).toEqual([
      expect.objectContaining({ name: 'reviewer_gate', total_minutes: 21812, share_percent: 30.33 }),
      expect.objectContaining({ name: 'auto_enqueue', total_minutes: 4590, share_percent: 6.38 }),
    ]);
  });

  test('resolveAlertBand escalates at the configured thresholds', () => {
    expect(resolveAlertBand(40)).toBe('ok');
    expect(resolveAlertBand(60)).toBe('60');
    expect(resolveAlertBand(85)).toBe('80');
    expect(resolveAlertBand(120)).toBe('100');
  });
});
