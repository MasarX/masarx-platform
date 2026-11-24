const { readFileSync } = require('node:fs');
const { lexSqlForIsolation, splitTopLevelSqlStatements } = require('../ops/pr-validation-focused-isolation');

function retryRefusal(sql) {
  // shortcut: assumes standard quoting, ASCII dollar tags and semicolon-delimited SQL. Use a parser if migrations need other SQL syntax.
  const lexed = lexSqlForIsolation(sql);
  if (lexed.errors.length || lexed.metaCommands.length) return 'could not inspect the migration SQL';

  const statements = splitTopLevelSqlStatements(lexed);
  for (const [index, { tokens }] of statements.entries()) {
    const words = tokens.map(token => token.type === 'identifier' ? token.value : '');
    if (words.includes('concurrently')) return 'contains the bare keyword CONCURRENTLY (unsafe to replay)';

    const first = words[0];
    // REINDEX permits a parenthesized option list before its target kind.
    let target = 1;
    if (first === 'reindex' && tokens[1]?.type === 'symbol' && tokens[1].value === '(') {
      target = tokens.findIndex(token => token.type === 'symbol' && token.value === ')') + 1;
      if (target === 0) return 'could not inspect the migration SQL';
    }
    const command = /^(vacuum|cluster|alter system|reindex (?:schema|database|system)|(?:create|drop) (?:database|tablespace)|commit prepared)(?: |$)/
      .exec(`${first} ${words[target] ?? ''}`)?.[1];
    if (command) return `contains ${command.toUpperCase()} (unsafe to replay)`;
    if ((first === 'commit' || first === 'end') && index < statements.length - 1) {
      return 'contains a top-level COMMIT or END before the final statement (unsafe to replay)';
    }
  }
  return '';
}

const sql = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(process.argv[2]));
const reason = retryRefusal(sql);
if (reason) process.stdout.write(`${reason}\n`);
