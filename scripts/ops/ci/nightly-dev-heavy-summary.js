#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { parseFlagArgs } = require('../../utils/cli-args');

const JOB_IDS = ['core', 'ui', 'landing', 'mobile'];

function normalizeValue(raw, fallback = '') {
  const value = String(raw == null ? '' : raw).trim();
  return value || String(fallback || '').trim();
}

function normalizeResult(raw) {
  return normalizeValue(raw, 'unknown').toLowerCase();
}

function buildNightlyDevHeavySummary(input = {}) {
  const jobs = JOB_IDS.map((jobId) => {
    const details = input[jobId] && typeof input[jobId] === 'object' ? input[jobId] : {};
    const result = normalizeResult(details.result);
    const failureClass = normalizeValue(details.failureClass, result === 'success' ? '' : `${jobId}_${result}`);
    return {
      job_id: jobId,
      label: normalizeValue(details.label, jobId),
      result,
      failure_class: result === 'success' ? '' : failureClass,
    };
  });

  const failures = jobs.filter((job) => job.result !== 'success');

  return {
    repo: normalizeValue(input.repo),
    ref: normalizeValue(input.ref, 'dev'),
    workflow: normalizeValue(input.workflow, 'Nightly Dev Heavy'),
    generated_at: normalizeValue(input.generatedAt, new Date().toISOString()),
    run_id: normalizeValue(input.runId),
    run_attempt: normalizeValue(input.runAttempt),
    run_url: normalizeValue(input.runUrl),
    status: failures.length === 0 ? 'passed' : 'failed',
    jobs,
    failures,
  };
}

function formatMarkdown(summary) {
  const lines = [
    '### Nightly Dev Heavy',
    '',
    `- Repository: \`${summary.repo || ''}\``,
    `- Ref: \`${summary.ref || 'dev'}\``,
    `- Generated: \`${summary.generated_at || ''}\``,
    `- Status: \`${summary.status || 'unknown'}\``,
    `- Run: ${summary.run_url ? `[${summary.run_id || 'current'}](${summary.run_url})` : `\`${summary.run_id || '<none>'}\``}`,
    '',
    '#### Jobs',
  ];

  for (const job of summary.jobs || []) {
    lines.push(
      `- \`${job.job_id}\`: \`${job.result}\`${job.failure_class ? ` (${job.failure_class})` : ''}`,
    );
  }

  if (Array.isArray(summary.failures) && summary.failures.length) {
    lines.push('');
    lines.push('#### Failures');
    for (const failure of summary.failures) {
      lines.push(`- \`${failure.job_id}\`: \`${failure.failure_class || failure.result}\``);
    }
  }

  return `${lines.join('\n')}\n`;
}

function writeFile(targetPath, payload) {
  const resolved = path.resolve(process.cwd(), String(targetPath || '').trim());
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, payload, 'utf8');
  return resolved;
}

function parseArgs(argv = process.argv.slice(2)) {
  const flags = parseFlagArgs(argv);
  return {
    jsonOut: normalizeValue(flags['json-out'], 'nightly-dev-heavy-summary.json'),
    mdOut: normalizeValue(flags['md-out'], 'nightly-dev-heavy-summary.md'),
  };
}

function main(argv = process.argv.slice(2)) {
  const { jsonOut, mdOut } = parseArgs(argv);
  const summary = buildNightlyDevHeavySummary({
    repo: process.env.REPO,
    ref: process.env.TARGET_REF,
    workflow: process.env.WORKFLOW_NAME,
    generatedAt: process.env.GENERATED_AT,
    runId: process.env.RUN_ID,
    runAttempt: process.env.RUN_ATTEMPT,
    runUrl: process.env.RUN_URL,
    core: {
      result: process.env.CORE_RESULT,
      failureClass: process.env.CORE_FAILURE_CLASS,
      label: 'Nightly Dev Heavy / Core',
    },
    ui: {
      result: process.env.UI_RESULT,
      failureClass: process.env.UI_FAILURE_CLASS,
      label: 'Nightly Dev Heavy / UI',
    },
    landing: {
      result: process.env.LANDING_RESULT,
      failureClass: process.env.LANDING_FAILURE_CLASS,
      label: 'Nightly Dev Heavy / Landing',
    },
    mobile: {
      result: process.env.MOBILE_RESULT,
      failureClass: process.env.MOBILE_FAILURE_CLASS,
      label: 'Nightly Dev Heavy / Mobile',
    },
  });

  writeFile(jsonOut, `${JSON.stringify(summary, null, 2)}\n`);
  writeFile(mdOut, formatMarkdown(summary));
  console.log(
    `[nightly-dev-heavy-summary] status=${summary.status} failures=${summary.failures.map((entry) => entry.job_id).join(',') || '<none>'}`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  JOB_IDS,
  buildNightlyDevHeavySummary,
  formatMarkdown,
  normalizeResult,
  normalizeValue,
};
