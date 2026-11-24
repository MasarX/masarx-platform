const { readFileSync } = require('node:fs');
const { analyzeMigrationReplay } = require('../ops/pr-validation-focused-isolation');

function retryRefusal(sql, failedIndex) {
  const { hazards, statementCount } = analyzeMigrationReplay(sql);
  const hazard = hazards[0];
  if (hazard?.code.startsWith('sql_lex_') || hazard?.code === 'psql_meta_command') {
    return 'could not inspect the migration SQL';
  }
  if (hazard?.code === 'transaction_commit') {
    return 'contains a COMMIT or END outside the final statement (unsafe to replay)';
  }
  if (hazard) return `contains ${hazard.code} at line ${hazard.line} (unsafe to replay)`;
  // The CLI appends history after the migration statements, even after an explicit COMMIT.
  if (!Number.isSafeInteger(failedIndex) || failedIndex < 0 || failedIndex >= statementCount) {
    return 'could not match the failing statement to the migration';
  }
  return '';
}

const sql = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(process.argv[2]));
const reason = retryRefusal(sql, Number(process.argv[3]));
if (reason) process.stdout.write(`${reason}\n`);
