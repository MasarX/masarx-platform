'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sanitize } = require('./diagnostics.cjs');

const cell = value => sanitize(value ?? 'UNKNOWN').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\|/g, '&#124;').replace(/[\r\n]+/g, ' ');
function databaseResult(build, shards, env = process.env) {
  let ok = env.BUILD_RESULT === 'success';
  if (env.DATABASE_PRESENT === 'false') return { ok: ok && env.PGTAP_RESULT === 'skipped', markdown: 'Database subject absent; pgTAP skipped by design.\n' };
  ok = ok && env.DATABASE_PRESENT === 'true' && env.PGTAP_RESULT === 'success'
    && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')
    && build?.sha === env.GITHUB_SHA && build?.ok === true
    && Number.isInteger(build?.migrations) && build.migrations > 0 && build.migrations === build.migrationTotal
    && build?.migrationFailed === 0 && build?.migrationNotRun === 0 && build?.lint?.ok === true;
  const lines = ['### Database result', '', `Build job: ${cell(env.BUILD_RESULT)}; pgTAP jobs: ${cell(env.PGTAP_RESULT)}`, '',
    '| Migrations applied | Failed | Not run |', '|---:|---:|---:|',
    `| ${cell(build?.migrations)} | ${cell(build?.migrationFailed)} | ${cell(build?.migrationNotRun)} |`, '',
    `Backend lint: ${build?.lint?.ok === true ? 'PASS' : 'FAIL / MISSING'}; existing exceptions: ${cell(build?.lint?.ignored)}`, '',
    '| Function | Lint message |', '|---|---|'];
  for (const finding of build?.lint?.findings || []) lines.push(`| ${cell(finding.function)} | ${cell(finding.message)} |`);
  if (build?.lint?.failure) lines.push('', `Lint failure: ${cell(build.lint.failure)}`);
  for (const command of build?.lint?.commands || []) if (!command.ok) lines.push('', `${cell(command.script)}: ${cell(command.failure?.message)}`);
  lines.push('', '| Shard | Migrations applied / failed | Files run | Passed | Failed | Result |', '|---|---:|---:|---:|---:|---|');
  if (shards.length !== 6) ok = false;
  for (let index = 1; index <= 6; index++) {
    const matches = shards.filter(row => row.shard === `${index}/6`);
    const shard = matches.length === 1 ? matches[0] : undefined;
    const passed = shard?.sha === env.GITHUB_SHA && shard?.ok === true && shard?.failed === 0
      && shard?.migrations === build?.migrationTotal && shard?.migrationFailed === 0 && shard?.migrationNotRun === 0
      && Number.isInteger(shard?.run) && shard.run > 0 && shard.run === shard.passed
      && shard.run === shard.selected?.length && shard.notRun?.length === 0;
    ok = ok && passed;
    lines.push(`| ${index}/6 | ${cell(shard?.migrations)} / ${cell(shard?.migrationFailed)} | ${cell(shard?.run)} | ${cell(shard?.passed)} | ${cell(shard?.failed)} | ${passed ? 'PASS' : 'FAIL / MISSING'} |`);
  }
  for (const shard of shards) {
    if (shard.failure) lines.push('', `${cell(shard.shard)}: ${cell(shard.failure.message)}`);
    for (const file of shard.files || []) if (file.status === 'failed') {
      const first = String(file.error || '').split(/\r?\n/).find(line => /ERROR:|FATAL:|\bnot ok\b|looks like you (failed|planned)/i.test(line)) || String(file.error || '').split(/\r?\n/)[0];
      lines.push('', `${cell(shard.shard)} ${cell(file.file)}: ${cell(first)}`);
    }
  }
  return { ok: Boolean(ok), markdown: `${lines.join('\n')}\n` };
}

function main() {
  const root = 'ci-reports/database-result';
  const errors = [];
  const read = file => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { errors.push(sanitize(error.message)); return undefined; }
  };
  const latest = (dir, name) => {
    const selected = new Map();
    const files = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter(file => path.basename(file) === name) : [];
    for (const file of files) {
      const artifact = file === name && files.length === 1 ? `${name}-0` : file.split(path.sep)[0];
      const match = /^(.*)-(\d+)$/.exec(artifact);
      if (!match) { errors.push(`Invalid report artifact: ${artifact}`); continue; }
      const previous = selected.get(match[1]);
      if (!previous || Number(match[2]) > previous.attempt) selected.set(match[1], { file, attempt: Number(match[2]) });
    }
    // Partial job reruns reuse unchanged producers; never fall back from a malformed newer report.
    return [...selected.values()].map(row => read(path.join(dir, row.file))).filter(Boolean);
  };
  const builds = process.env.DATABASE_PRESENT === 'true' ? latest(path.join(root, 'build'), 'backend.json') : [];
  const build = builds.length === 1 ? builds[0] : undefined;
  const shards = latest(path.join(root, 'shards'), 'pgtap.json');
  const result = databaseResult(build, shards);
  const markdown = result.markdown + errors.map(error => `\nReport error: ${cell(error)}\n`).join('');
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  if (!result.ok || errors.length) process.exitCode = 1;
}
if (require.main === module) main();
module.exports = { databaseResult };
