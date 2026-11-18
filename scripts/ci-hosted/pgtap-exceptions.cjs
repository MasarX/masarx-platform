'use strict';
const fs = require('node:fs');
const nonemptyText = value => typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\r\n]/.test(value);

function loadExceptions(file = 'config/ci/pgtap-accepted-failures.json') {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(entries)) throw new Error('pgTAP exceptions must be an array');
  for (const entry of entries) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'assertions,expires,file,owner,reason'
      || typeof entry.file !== 'string' || !/^[a-zA-Z0-9_.-]+\.sql$/i.test(entry.file)
      || !nonemptyText(entry.owner) || !nonemptyText(entry.reason)
      || !Array.isArray(entry.assertions) || !entry.assertions.length || !entry.assertions.every(nonemptyText)
      || new Set(entry.assertions).size !== entry.assertions.length
      || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires) || !Number.isFinite(Date.parse(entry.expires))
      || new Date(entry.expires).toISOString().slice(0, 10) !== entry.expires) throw new Error('Malformed pgTAP exception');
  }
  const assertions = entries.flatMap(({ assertions, ...entry }) => assertions.map(assertion => ({ ...entry, assertion })));
  const identities = assertions.map(({ file, assertion }) => JSON.stringify([file, assertion]));
  if (new Set(identities).size !== identities.length) throw new Error('Duplicate pgTAP file/assertion exception');
  return assertions;
}
function assessFile(file, result, entries, today = new Date().toISOString().slice(0, 10)) {
  const assertions = []; const plans = []; const errors = []; const failureCounts = [];
  const output = String(result.combined || '');
  for (const line of output.split(/\r?\n/)) {
    // psql's aligned multiline output pads lines and appends a continuation '+'.
    const text = line.trim().replace(/\s+\+$/, '').trimEnd();
    const assertion = /^(not ok|ok)\s+(\d+)\s*(?:-\s*(.*))?$/.exec(text);
    if (assertion) assertions.push({ failed: assertion[1] === 'not ok', number: Number(assertion[2]), assertion: assertion[3] || '' });
    const plan = /^1\.\.(\d+)$/.exec(text);
    if (plan) plans.push(Number(plan[1]));
    const count = /^# Looks like you failed (\d+) tests? of \d+/.exec(text);
    if (count) failureCounts.push(Number(count[1]));
  }
  const failedCount = assertions.filter(row => row.failed).length;
  const complete = failureCounts.every(count => count === failedCount) && plans.length === 1 && plans[0] > 0 && assertions.length === plans[0]
    && assertions.every((row, index) => row.number === index + 1);
  const abort = result.status !== 0 || /ERROR:|FATAL:|PANIC:|Bail out!|looks like you planned|no plan|died before/i.test(output);
  const accepted = [];
  for (const entry of entries.filter(row => row.file === file)) {
    const matches = assertions.filter(row => row.assertion === entry.assertion);
    if (matches.length !== 1 || !matches[0].failed) errors.push(`stale exception: remove it: ${entry.file}: ${entry.assertion}`);
    else if (today > entry.expires) errors.push(`Expired pgTAP exception (${entry.expires}): ${entry.file}: ${entry.assertion}`);
    else if (complete && !abort) accepted.push({ ...entry });
  }
  const failures = assertions.filter(row => row.failed && !accepted.some(entry => entry.assertion === row.assertion));
  const tapFailure = /\bnot ok\b|looks like you (failed|planned)/i.test(output);
  return { ok: !abort && !errors.length && !failures.length && (!tapFailure || (complete && accepted.length > 0)), accepted, errors, failures };
}
function exceptionEvidence(entries, shards, today = new Date().toISOString().slice(0, 10)) {
  const errors = []; const accepted = [];
  for (const shard of shards) for (const file of shard.files || []) {
    for (const entry of file.accepted || []) {
      if (!entries.some(row => JSON.stringify(row) === JSON.stringify(entry)) || today > entry.expires) errors.push(`Invalid or expired accepted assertion: ${file.file}: ${entry.assertion}`);
      else accepted.push({ ...entry, reportedFile: file.file });
    }
  }
  for (const entry of entries) {
    const matches = accepted.filter(row => row.reportedFile === entry.file && row.assertion === entry.assertion);
    if (matches.length !== 1) errors.push(`stale exception: remove it (or restore missing execution evidence): ${entry.file}: ${entry.assertion}`);
  }
  return { errors, accepted };
}
module.exports = { loadExceptions, assessFile, exceptionEvidence };

if (require.main === module) {
  const assert = require('node:assert/strict');
  const os = require('node:os');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pgtap-exceptions-'));
  const config = path.join(directory, 'exceptions.json');
  try {
    const entries = ['first', 'second'].map(name => ({ file: `${name}.sql`, assertions: [`${name} assertion`],
      expires: name === 'first' ? '2026-12-01' : '2026-11-19', reason: 'synthetic reason', owner: 'synthetic owner' }));
    fs.writeFileSync(config, JSON.stringify(entries));
    const loaded = loadExceptions(config);
    assert.equal(loaded.length, 2);
    for (const entry of loaded) {
      const result = { status: 0, combined: `1..1\nnot ok 1 - ${entry.assertion}` };
      assert.equal(assessFile(entry.file, result, loaded, '2026-11-18').ok, true);
      assert.deepEqual(assessFile(entry.file, result, loaded, '2026-11-18').accepted, [entry]);
      assert.equal(assessFile(entry.file, result, loaded, '2026-11-20').ok, entry.file === 'first.sql');
      assert.equal(assessFile('other.sql', result, loaded, '2026-11-18').ok, false);
      assert.equal(assessFile(entry.file, result, loaded, '2026-12-02').ok, false);
      assert.match(assessFile(entry.file, { ...result, combined: `1..1\nok 1 - ${entry.assertion}` },
        loaded, '2026-11-18').errors[0], /stale exception/);
      assert.equal(assessFile(entry.file, { ...result, status: 1, combined: `${result.combined}\nERROR: synthetic abort` },
        loaded, '2026-11-18').accepted.length, 0);
    }
    fs.writeFileSync(config, JSON.stringify([entries[0], entries[0]]));
    assert.throws(() => loadExceptions(config), /Duplicate/);
    console.log('PASS: two entries retain exact file/assertion matching, expiry, staleness and SQL-abort refusal; duplicates rejected');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
