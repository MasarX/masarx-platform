#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const { parseFlagArgs } = require('../../utils/cli-args');

const DEFAULT_INCLUDED_MINUTES = 50_000;
const DEFAULT_TOP = 10;
const ALERT_THRESHOLDS = Object.freeze([
  { key: '100', minimumPercent: 100 },
  { key: '80', minimumPercent: 80 },
  { key: '60', minimumPercent: 60 },
]);

function parseArgs(argv = process.argv.slice(2), now = new Date()) {
  const flags = parseFlagArgs(argv);
  return {
    summaryCsv: String(flags['summary-csv'] || flags.summary || '').trim(),
    workflowCsv: String(flags['workflow-csv'] || flags.workflows || '').trim(),
    jobCsv: String(flags['job-csv'] || flags.jobs || '').trim(),
    from: String(flags.from || '').trim(),
    to: String(flags.to || now.toISOString().slice(0, 10)).trim(),
    includedMinutes: Number.parseInt(String(flags['included-minutes'] || DEFAULT_INCLUDED_MINUTES).trim(), 10) || DEFAULT_INCLUDED_MINUTES,
    top: Number.parseInt(String(flags.top || DEFAULT_TOP).trim(), 10) || DEFAULT_TOP,
    format: String(flags.format || 'json').trim().toLowerCase(),
  };
}

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeCell(value) {
  let text = String(value == null ? '' : value).trim();
  while (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith("'")) text = text.slice(1);
  return text.trim();
}

function parseCsv(raw) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const text = String(raw || '');
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((value) => String(value).trim() !== '')) rows.push(row);
      row = [];
      continue;
    }

    field += char;
  }

  if (field.length || row.length) {
    row.push(field);
    if (row.some((value) => String(value).trim() !== '')) rows.push(row);
  }

  return rows.map((cells) => cells.map((cell) => normalizeCell(cell)));
}

function parseCsvFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const rows = parseCsv(raw);
  if (!rows.length) return [];

  const [headerRow, ...dataRows] = rows;
  const headers = headerRow.map((value) => normalizeHeader(value));
  return dataRows.map((cells) => {
    const entry = {};
    for (let index = 0; index < headers.length; index += 1) {
      entry[headers[index]] = normalizeCell(cells[index] || '');
    }
    return entry;
  });
}

function parseNumber(value) {
  const normalized = String(value == null ? '' : value).replace(/,/g, '').trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function diffDaysInclusive(from, to) {
  if (!(from instanceof Date) || !(to instanceof Date)) return 0;
  const ms = to.getTime() - from.getTime();
  return ms >= 0 ? Math.floor(ms / 86_400_000) + 1 : 0;
}

function daysInMonth(date) {
  if (!(date instanceof Date)) return 0;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

function round(value, digits = 2) {
  return Number(Number(value || 0).toFixed(digits));
}

function buildTopRows(rows, nameKey, minutesKey, runsKey, totalMinutes, limit) {
  const sorted = (Array.isArray(rows) ? rows : [])
    .map((entry) => ({
      name: String(entry?.[nameKey] || '').trim(),
      total_minutes: parseNumber(entry?.[minutesKey]),
      runs: parseNumber(entry?.[runsKey]),
    }))
    .filter((entry) => entry.name)
    .sort((left, right) => right.total_minutes - left.total_minutes)
    .slice(0, Math.max(1, limit));

  return sorted.map((entry) => ({
    ...entry,
    share_percent: totalMinutes > 0 ? round((entry.total_minutes / totalMinutes) * 100, 2) : 0,
  }));
}

function resolveAlertBand(percent) {
  for (const threshold of ALERT_THRESHOLDS) {
    if (percent >= threshold.minimumPercent) return threshold.key;
  }
  return 'ok';
}

function collectReport({
  summaryCsv,
  workflowCsv,
  jobCsv,
  from,
  to,
  includedMinutes = DEFAULT_INCLUDED_MINUTES,
  top = DEFAULT_TOP,
}) {
  if (!workflowCsv) throw new Error('Missing workflow CSV path.');

  const workflowRows = parseCsvFile(workflowCsv);
  const jobRows = jobCsv ? parseCsvFile(jobCsv) : [];
  const summaryRows = summaryCsv ? parseCsvFile(summaryCsv) : [];

  const totalMinutes = summaryRows.length
    ? parseNumber(summaryRows[0]?.total_minutes)
    : workflowRows.reduce((sum, entry) => sum + parseNumber(entry?.total_minutes), 0);
  const workflowRuns = summaryRows.length
    ? parseNumber(summaryRows[0]?.workflow_runs)
    : workflowRows.reduce((sum, entry) => sum + parseNumber(entry?.workflow_runs), 0);
  const workflows = summaryRows.length
    ? parseNumber(summaryRows[0]?.workflows)
    : workflowRows.length;
  const jobRuns = jobRows.reduce((sum, entry) => sum + parseNumber(entry?.job_runs), 0);

  const fromDate = parseDateOnly(from);
  const toDate = parseDateOnly(to);
  const elapsedDays = diffDaysInclusive(fromDate, toDate);
  const monthDays = daysInMonth(fromDate || toDate);
  const projectedMonthEndMinutes = elapsedDays > 0 && monthDays > 0
    ? round((totalMinutes / elapsedDays) * monthDays, 2)
    : totalMinutes;
  const currentPoolUtilizationPercent = includedMinutes > 0 ? round((totalMinutes / includedMinutes) * 100, 2) : 0;
  const projectedPoolUtilizationPercent = includedMinutes > 0 ? round((projectedMonthEndMinutes / includedMinutes) * 100, 2) : 0;

  return {
    generated_at: new Date().toISOString(),
    window: {
      from: fromDate ? from : '',
      to: toDate ? to : '',
      elapsed_days: elapsedDays,
      month_days: monthDays,
    },
    included_minutes: includedMinutes,
    total_minutes: round(totalMinutes, 2),
    total_workflow_runs: workflowRuns,
    total_job_runs: jobRuns,
    total_workflows: workflows,
    current_pool_utilization_percent: currentPoolUtilizationPercent,
    projected_month_end_minutes: projectedMonthEndMinutes,
    projected_pool_utilization_percent: projectedPoolUtilizationPercent,
    alert_band: resolveAlertBand(projectedPoolUtilizationPercent),
    thresholds: [60, 80, 100],
    top_workflows: buildTopRows(workflowRows, 'workflow', 'total_minutes', 'workflow_runs', totalMinutes, top),
    top_jobs: buildTopRows(jobRows, 'job', 'total_minutes', 'job_runs', totalMinutes, top),
  };
}

function printReport(report, format = 'json') {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  if (format === 'table') {
    const lines = [
      'type\tname\tminutes\truns\tshare%',
      ...report.top_workflows.map((entry) => ['workflow', entry.name, entry.total_minutes, entry.runs, entry.share_percent].join('\t')),
      ...report.top_jobs.map((entry) => ['job', entry.name, entry.total_minutes, entry.runs, entry.share_percent].join('\t')),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  if (format === 'md' || format === 'markdown') {
    const lines = [
      '# Hosted Usage Report',
      '',
      `- Window: ${report.window.from || '<unknown>'} -> ${report.window.to || '<unknown>'}`,
      `- Total hosted minutes: ${report.total_minutes}`,
      `- Projected month-end minutes: ${report.projected_month_end_minutes}`,
      `- Enterprise pool utilization: ${report.current_pool_utilization_percent}% current / ${report.projected_pool_utilization_percent}% projected`,
      `- Alert band: ${report.alert_band}`,
      '',
      '## Top workflows',
      '',
      '| Workflow | Minutes | Runs | Share % |',
      '| --- | ---: | ---: | ---: |',
      ...report.top_workflows.map((entry) => `| ${entry.name} | ${entry.total_minutes} | ${entry.runs} | ${entry.share_percent} |`),
      '',
      '## Top jobs',
      '',
      '| Job | Minutes | Runs | Share % |',
      '| --- | ---: | ---: | ---: |',
      ...report.top_jobs.map((entry) => `| ${entry.name} | ${entry.total_minutes} | ${entry.runs} | ${entry.share_percent} |`),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  throw new Error(`Unsupported format "${format}"`);
}

function main() {
  const args = parseArgs();
  const report = collectReport(args);
  printReport(report, args.format);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[hosted-usage-report] ${error.message || error}`);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_INCLUDED_MINUTES,
  DEFAULT_TOP,
  ALERT_THRESHOLDS,
  parseArgs,
  normalizeHeader,
  normalizeCell,
  parseCsv,
  parseCsvFile,
  parseNumber,
  parseDateOnly,
  diffDaysInclusive,
  daysInMonth,
  buildTopRows,
  resolveAlertBand,
  collectReport,
  printReport,
};
