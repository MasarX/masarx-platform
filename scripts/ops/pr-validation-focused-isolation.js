#!/usr/bin/env node
/* eslint-disable no-console */
const {
  ISOLATION_SCANNER_VERSION,
  canonicalJson,
  compareAscii,
  sha256,
} = require('./pr-validation-focused-common');
const { normalizeRequestedFocusedFile } = require('./pr-validation-focused-policy');

function lexSqlForIsolation(sourceValue) {
  const source = String(sourceValue == null ? '' : sourceValue);
  const masked = source.split('');
  const tokens = [];
  const regions = [];
  const metaCommands = [];
  const errors = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const mark = () => ({ index, line, column });
  const consumeTo = (end, shouldMask = false) => {
    while (index < end) {
      const char = source[index];
      if (shouldMask && char !== '\r' && char !== '\n') masked[index] = ' ';
      if (char === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      index += 1;
    }
  };
  const addToken = (type, start, end, value, extra = {}) => {
    tokens.push({ type, value, start: start.index, end, line: start.line, column: start.column, ...extra });
  };
  const lexicalError = (code, start) => errors.push({ code, index: start.index, line: start.line, column: start.column });

  while (index < source.length) {
    const start = mark();
    const char = source[index];
    const next = source[index + 1] || '';

    if (/\s/u.test(char)) {
      consumeTo(index + 1, false);
      continue;
    }

    if (char === '-' && next === '-') {
      let end = index + 2;
      while (end < source.length && source[end] !== '\r' && source[end] !== '\n') end += 1;
      regions.push({ type: 'line_comment', start: start.index, end, line: start.line, column: start.column });
      consumeTo(end, true);
      continue;
    }

    if (char === '/' && next === '*') {
      let cursor = index + 2;
      let depth = 1;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === '/' && source[cursor + 1] === '*') {
          depth += 1;
          cursor += 2;
        } else if (source[cursor] === '*' && source[cursor + 1] === '/') {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (depth > 0) lexicalError('sql_lex_unterminated_block_comment', start);
      const end = depth > 0 ? source.length : cursor;
      regions.push({ type: 'block_comment', start: start.index, end, line: start.line, column: start.column });
      consumeTo(end, true);
      continue;
    }

    const isEscapedString = (char === 'e' || char === 'E') && next === "'";
    if (char === "'" || isEscapedString) {
      const quoteIndex = isEscapedString ? index + 1 : index;
      let cursor = quoteIndex + 1;
      let closed = false;
      let literal = '';
      while (cursor < source.length) {
        if (source[cursor] === "'" && source[cursor + 1] === "'") {
          literal += "'";
          cursor += 2;
          continue;
        }
        if (isEscapedString && source[cursor] === '\\' && cursor + 1 < source.length) {
          literal += source[cursor + 1];
          cursor += 2;
          continue;
        }
        if (source[cursor] === "'") {
          cursor += 1;
          closed = true;
          break;
        }
        literal += source[cursor];
        cursor += 1;
      }
      if (!closed) lexicalError('sql_lex_unterminated_single_quote', start);
      const end = closed ? cursor : source.length;
      regions.push({ type: 'string', start: start.index, end, line: start.line, column: start.column });
      addToken('string', start, end, '?', { literal });
      consumeTo(end, true);
      continue;
    }

    if (char === '"') {
      let cursor = index + 1;
      let closed = false;
      let identifier = '';
      while (cursor < source.length) {
        if (source[cursor] === '"' && source[cursor + 1] === '"') {
          identifier += '"';
          cursor += 2;
          continue;
        }
        if (source[cursor] === '"') {
          cursor += 1;
          closed = true;
          break;
        }
        identifier += source[cursor];
        cursor += 1;
      }
      if (!closed) lexicalError('sql_lex_unterminated_double_quote', start);
      const end = closed ? cursor : source.length;
      regions.push({ type: 'quoted_identifier', start: start.index, end, line: start.line, column: start.column });
      addToken('quoted_identifier', start, end, identifier.toLowerCase());
      consumeTo(end, true);
      continue;
    }

    if (char === '$' && !/[A-Za-z0-9_$]/u.test(source[index - 1] || '')) {
      const match = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u);
      if (match) {
        const delimiter = match[0];
        const bodyStart = index + delimiter.length;
        const closeIndex = source.indexOf(delimiter, bodyStart);
        if (closeIndex < 0) {
          lexicalError('sql_lex_unterminated_dollar_quote', start);
          const body = source.slice(bodyStart);
          regions.push({ type: 'dollar_body', start: start.index, end: source.length, line: start.line, column: start.column });
          addToken('dollar_body', start, source.length, '?', { delimiter, body });
          consumeTo(source.length, true);
          continue;
        }
        const end = closeIndex + delimiter.length;
        const body = source.slice(bodyStart, closeIndex);
        regions.push({ type: 'dollar_body', start: start.index, end, line: start.line, column: start.column });
        addToken('dollar_body', start, end, '?', { delimiter, body });
        consumeTo(end, true);
        continue;
      }
    }

    if (char === '\\') {
      metaCommands.push({ code: 'psql_meta_command', index: start.index, line: start.line, column: start.column });
      addToken('symbol', start, index + 1, char);
      consumeTo(index + 1, false);
      continue;
    }

    if (/[A-Za-z_]/u.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/u.test(source[end])) end += 1;
      addToken('identifier', start, end, source.slice(index, end).toLowerCase());
      consumeTo(end, false);
      continue;
    }

    if (/[0-9]/u.test(char)) {
      let end = index + 1;
      while (end < source.length && /[0-9.]/u.test(source[end])) end += 1;
      addToken('number', start, end, source.slice(index, end));
      consumeTo(end, false);
      continue;
    }

    addToken(char === ';' ? 'semicolon' : 'symbol', start, index + 1, char);
    consumeTo(index + 1, false);
  }

  return {
    sourceLength: source.length,
    maskedSql: masked.join(''),
    tokens,
    regions,
    metaCommands,
    errors,
  };
}

function splitTopLevelSqlStatements(lexed) {
  const statements = [];
  let current = [];
  for (const token of lexed.tokens || []) {
    if (token.type === 'semicolon') {
      if (current.length) {
        statements.push({
          tokens: current,
          start: current[0].start,
          end: token.end,
          line: current[0].line,
          column: current[0].column,
          terminated: true,
        });
      }
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) {
    statements.push({
      tokens: current,
      start: current[0].start,
      end: current[current.length - 1].end,
      line: current[0].line,
      column: current[0].column,
      terminated: false,
    });
  }
  return statements;
}

function compactStatement(statement) {
  return (statement.tokens || []).map((token) => token.value).join('').toLowerCase();
}

function statementFirstWord(statement) {
  const token = (statement.tokens || []).find((entry) => entry.type === 'identifier' || entry.type === 'quoted_identifier');
  return token ? token.value : '';
}

function statementIsBegin(statement) {
  const tokens = statement.tokens || [];
  const words = tokens.filter((token) => token.type === 'identifier').map((token) => token.value);
  const allowedModeWords = new Set([
    'work', 'transaction', 'isolation', 'level', 'serializable', 'repeatable', 'read',
    'committed', 'uncommitted', 'write', 'only', 'deferrable', 'not',
  ]);
  if (words[0] === 'begin') return words.slice(1).every((word) => allowedModeWords.has(word));
  return words[0] === 'start'
    && words[1] === 'transaction'
    && words.slice(2).every((word) => allowedModeWords.has(word));
}

function statementIsFinalRollback(statement) {
  return /^rollback(?:work|transaction)?$/u.test(compactStatement(statement));
}

function statementIsFinish(statement) {
  return /^select(?:\*from)?(?:[a-z_][a-z0-9_$]*\.)?finish\(\)$/u.test(compactStatement(statement));
}

function statementIsPrelude(statement) {
  const tokens = statement.tokens || [];
  const words = tokens.filter((token) => token.type === 'identifier').map((token) => token.value);
  if (words[0] === 'show') return true;
  if (words[0] !== 'set') return false;
  const offset = new Set(['local', 'session']).has(words[1]) ? 2 : 1;
  return words[offset] === 'search_path';
}

function calledFunctions(tokens = []) {
  const out = [];
  const identifierType = (token) => token && (token.type === 'identifier' || token.type === 'quoted_identifier');
  for (let index = 0; index < tokens.length; index += 1) {
    if (!identifierType(tokens[index])) continue;
    const segments = [tokens[index].value];
    let cursor = index + 1;
    while (tokens[cursor]?.value === '.' && identifierType(tokens[cursor + 1])) {
      segments.push(tokens[cursor + 1].value);
      cursor += 2;
    }
    if (tokens[cursor]?.value === '(') {
      out.push({
        name: segments.join('.').toLowerCase(),
        line: tokens[index].line,
        column: tokens[index].column,
        index: tokens[index].start,
      });
    }
  }
  return out;
}

function classifyFunctionHazard(nameValue) {
  const name = String(nameValue || '').toLowerCase();
  const base = name.split('.').pop();
  if (/^pg_(?:try_)?advisory_xact_lock(?:_shared)?$/u.test(base)) return '';
  if (/^(?:nextval|setval)$/u.test(base)) return 'nontransactional_function';
  if (/^dblink/u.test(base) || /^pg_background/u.test(base)) return 'autonomous_side_effect';
  if (/^http(?:_|$)/u.test(base)) return 'autonomous_side_effect';
  if (/^cron\.(?:schedule|unschedule|alter_job)$/u.test(name)) return 'autonomous_side_effect';
  if (/^(?:lo_import|lo_export|pg_file_(?:write|rename|unlink|sync))$/u.test(base)) return 'external_file_side_effect';
  if (/^pg_logical_emit_message$/u.test(base)) return 'autonomous_side_effect';
  if (/^pg_(?:create|drop)_.*replication_slot$/u.test(base)) return 'autonomous_side_effect';
  if (/^pg_(?:terminate_backend|cancel_backend|reload_conf|promote|rotate_logfile)$/u.test(base)) return 'autonomous_side_effect';
  if (/^pg_(?:try_)?advisory_lock(?:_shared)?$/u.test(base)) return 'autonomous_side_effect';
  if (/^pg_advisory_unlock(?:_shared|_all)?$/u.test(base)) return 'autonomous_side_effect';
  if (/^pg_(?:switch_wal|create_restore_point|backup_start|backup_stop|wal_replay_pause|wal_replay_resume)$/u.test(base)) return 'autonomous_side_effect';
  return '';
}

function classifyCopyHazard(statement) {
  const tokens = statement.tokens || [];
  let depth = 0;
  let directionIndex = -1;
  for (let index = 1; index < tokens.length; index += 1) {
    if (tokens[index].value === '(') depth += 1;
    else if (tokens[index].value === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && tokens[index].type === 'identifier' && new Set(['to', 'from']).has(tokens[index].value)) {
      directionIndex = index;
      break;
    }
  }
  if (directionIndex < 0) return 'external_copy_target_unresolved';
  const target = tokens[directionIndex + 1];
  if (target?.type === 'identifier' && new Set(['stdout', 'stdin']).has(target.value)) return '';
  if (target?.type === 'identifier' && target.value === 'program') return 'autonomous_side_effect';
  if (target?.type === 'string') return 'external_file_side_effect';
  return 'external_copy_target_unresolved';
}

function classifyLexicalModeHazard(tokens = []) {
  const lexicalKeys = new Set(['standard_conforming_strings', 'backslash_quote', 'escape_string_warning']);
  const isIdentifier = (token) => token && new Set(['identifier', 'quoted_identifier']).has(token.type);
  const words = tokens.filter(isIdentifier).map((token) => token.value);
  if (words[0] === 'set') {
    const offset = new Set(['local', 'session']).has(words[1]) ? 2 : 1;
    if (lexicalKeys.has(words[offset])) return 'sql_lexical_mode_change';
  }
  if (words[0] === 'reset' && (words[1] === 'all' || lexicalKeys.has(words[1]))) return 'sql_lexical_mode_change';
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (!isIdentifier(tokens[index]) || tokens[index].value !== 'set_config' || tokens[index + 1]?.value !== '(') continue;
    if (tokens[index + 2]?.type !== 'string') return 'dynamic_guc_name_unresolved';
    if (lexicalKeys.has(String(tokens[index + 2].literal || '').toLowerCase())) {
      return 'sql_lexical_mode_change';
    }
  }
  return '';
}

function classifyStatementHazard(statement, options = {}) {
  const words = (statement.tokens || [])
    .filter((token) => token.type === 'identifier')
    .map((token) => token.value);
  const first = words[0] || '';
  const second = words[1] || '';
  if ((first === 'prepare' && second === 'transaction') || (first === 'commit' && second === 'prepared') || (first === 'rollback' && second === 'prepared')) {
    return 'prepared_transaction_control';
  }
  if (first === 'commit' || first === 'end') return 'transaction_commit';
  if (first === 'abort') return 'transaction_rollback_boundary';
  if (first === 'rollback' && second !== 'to' && options.allowExactFinalRollback !== true) return 'transaction_rollback_boundary';
  const lexicalModeHazard = classifyLexicalModeHazard(statement.tokens);
  if (lexicalModeHazard) return lexicalModeHazard;
  if (first === 'execute') return 'dynamic_sql_unresolved';
  if (new Set(['vacuum', 'analyze', 'cluster', 'reindex', 'checkpoint', 'load', 'call']).has(first)) {
    return 'nontransactional_statement';
  }
  if (first === 'discard' && second === 'all') return 'nontransactional_statement';
  if (new Set(['create', 'drop']).has(first) && new Set(['database', 'tablespace']).has(second)) return 'nontransactional_statement';
  if (first === 'alter' && second === 'system') return 'nontransactional_statement';
  if (words.includes('concurrently')) return 'nontransactional_statement';
  if (new Set(['create', 'alter', 'drop']).has(first) && second === 'subscription') return 'autonomous_side_effect';
  if (first === 'copy') return classifyCopyHazard(statement);
  return '';
}

function analyzeDecodedSql(value, sourceLabel, depth = 0, { allowFinalCommit = false } = {}) {
  const lexed = lexSqlForIsolation(value);
  const statements = splitTopLevelSqlStatements(lexed);
  const hazards = [];
  for (const error of lexed.errors) hazards.push({ code: error.code, line: error.line, column: error.column, source: sourceLabel });
  for (const meta of lexed.metaCommands) hazards.push({ code: meta.code, line: meta.line, column: meta.column, source: sourceLabel });
  for (const [index, statement] of statements.entries()) {
    const statementHazard = classifyStatementHazard(statement);
    const isAllowedCommit = allowFinalCommit && statementHazard === 'transaction_commit' && index === statements.length - 1;
    if (statementHazard && !isAllowedCommit) {
      hazards.push({ code: statementHazard, line: statement.line, column: statement.column, source: sourceLabel });
    }
    for (const call of calledFunctions(statement.tokens)) {
      const code = classifyFunctionHazard(call.name);
      if (code) hazards.push({ code, line: call.line, column: call.column, source: sourceLabel });
    }
    if (statementFirstWord(statement) === 'do') {
      if (depth >= 4) hazards.push({ code: 'dynamic_sql_unresolved', line: statement.line, column: statement.column, source: sourceLabel });
      else hazards.push(...inspectDoStatement(statement, depth + 1));
    }
  }
  return { hazards, statementCount: statements.length };
}

function analyzeMigrationReplay(sql) {
  return analyzeDecodedSql(sql, 'migration', 0, { allowFinalCommit: true });
}

function findMatchingCloseParen(tokens, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === '(') depth += 1;
    if (tokens[index].value === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function inspectExecuteExpression(tokens, executeIndex, statement, depth = 0) {
  const expression = tokens.slice(executeIndex + 1);
  const unresolved = () => [{
    code: 'dynamic_sql_unresolved', line: statement.line, column: statement.column, source: 'execute',
  }];
  if (!expression.length) return unresolved();
  if (expression[0].type === 'string') {
    if (expression.length !== 1) return unresolved();
    return analyzeDecodedSql(expression[0].literal, 'dynamic_sql_literal', depth + 1).hazards;
  }
  if (expression[0].type !== 'identifier' || expression[0].value !== 'format' || expression[1]?.value !== '(') {
    return unresolved();
  }
  const closeIndex = findMatchingCloseParen(expression, 1);
  if (closeIndex < 0 || closeIndex !== expression.length - 1) return unresolved();
  const args = expression.slice(2, closeIndex);
  const template = args[0];
  if (!template || template.type !== 'string' || (args[1] && args[1].value !== ',')) return unresolved();
  const formatText = String(template.literal || '');
  for (let index = 0; index < formatText.length; index += 1) {
    if (formatText[index] !== '%') continue;
    const directive = formatText[index + 1] || '';
    if (directive === '%' || directive.toLowerCase() === 'l') {
      index += 1;
      continue;
    }
    return unresolved();
  }
  return analyzeDecodedSql(formatText, 'execute_format', depth + 1).hazards;
}

function inspectDoStatement(statement, depth = 0) {
  if (statementFirstWord(statement) !== 'do') return [];
  const hazards = [];
  const languageIndex = statement.tokens.findIndex((token) => token.type === 'identifier' && token.value === 'language');
  const language = languageIndex >= 0 ? statement.tokens[languageIndex + 1] : null;
  if (languageIndex >= 0 && language?.value !== 'plpgsql') {
    return [{ code: 'dynamic_sql_unresolved', line: statement.line, column: statement.column, source: 'do_body' }];
  }
  const bodyTokens = statement.tokens.filter((token) => token.type === 'dollar_body' || token.type === 'string');
  if (bodyTokens.length !== 1) {
    return [{
      code: 'dynamic_sql_unresolved',
      line: statement.line,
      column: statement.column,
      source: 'do_body',
    }];
  }
  for (const bodyToken of bodyTokens) {
    const body = bodyToken.type === 'dollar_body' ? bodyToken.body : bodyToken.literal;
    const inner = lexSqlForIsolation(body);
    for (const error of inner.errors) {
      hazards.push({ code: error.code, line: statement.line, column: statement.column, source: 'do_body' });
    }
    for (const meta of inner.metaCommands) {
      hazards.push({ code: meta.code, line: statement.line, column: statement.column, source: 'do_body' });
    }
    for (const call of calledFunctions(inner.tokens)) {
      const code = classifyFunctionHazard(call.name);
      if (code) hazards.push({ code, line: statement.line, column: statement.column, source: 'do_body' });
    }
    for (const token of inner.tokens) {
      if (token.type === 'identifier' && token.value === 'commit') {
        hazards.push({ code: 'transaction_commit', line: statement.line, column: statement.column, source: 'do_body' });
      }
      if (token.type === 'identifier' && token.value === 'rollback') {
        hazards.push({ code: 'transaction_rollback_control', line: statement.line, column: statement.column, source: 'do_body' });
      }
      if (token.type === 'identifier' && new Set([
        'vacuum', 'analyze', 'cluster', 'reindex', 'checkpoint', 'discard', 'load', 'call',
      ]).has(token.value)) {
        hazards.push({ code: 'nontransactional_statement', line: statement.line, column: statement.column, source: 'do_body' });
      }
    }
    for (const innerStatement of splitTopLevelSqlStatements(inner)) {
      const tokens = innerStatement.tokens || [];
      const lexicalModeHazard = classifyLexicalModeHazard(tokens);
      if (lexicalModeHazard) hazards.push({ code: lexicalModeHazard, line: statement.line, column: statement.column, source: 'do_body' });
      for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index].type === 'identifier' && tokens[index].value === 'copy') {
          const code = classifyCopyHazard({ ...innerStatement, tokens: tokens.slice(index) });
          if (code) hazards.push({ code, line: statement.line, column: statement.column, source: 'do_body' });
        }
        if (tokens[index].type !== 'identifier' || tokens[index].value !== 'execute') continue;
        hazards.push(...inspectExecuteExpression(tokens, index, innerStatement, depth));
      }
    }
  }
  return hazards;
}

function uniqueSortedCodes(items) {
  return [...new Set(items.filter(Boolean))].sort(compareAscii);
}

function sortHazards(hazards) {
  const seen = new Set();
  const out = [];
  for (const hazard of hazards) {
    const normalized = {
      code: String(hazard.code || 'unknown'),
      line: Number(hazard.line || 0),
      column: Number(hazard.column || 0),
      source: String(hazard.source || 'top_level'),
    };
    const key = canonicalJson(normalized);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(normalized);
    }
  }
  return out.sort((left, right) => compareAscii(canonicalJson(left), canonicalJson(right)));
}

function analyzeFocusedPgtapIsolation(options = {}) {
  const file = normalizeRequestedFocusedFile(options.file);
  const source = String(options.source == null ? '' : options.source);
  const sourceDigest = sha256(source);
  const policy = options.policy;
  if (!policy || !policy.quarantineByFile) throw new Error('Focused isolation analysis requires validated policy.');
  const policyQuarantine = policy.quarantineByFile[file] || null;

  const lexed = lexSqlForIsolation(source);
  const statements = splitTopLevelSqlStatements(lexed);
  const reasons = [];
  const hazards = [];
  for (const error of lexed.errors) reasons.push(error.code);
  for (const meta of lexed.metaCommands) reasons.push(meta.code);

  const beginIndexes = [];
  const finishIndexes = [];
  const rollbackIndexes = [];
  statements.forEach((statement, index) => {
    if (statementIsBegin(statement)) beginIndexes.push(index);
    if (statementIsFinish(statement)) finishIndexes.push(index);
    if (statementIsFinalRollback(statement)) rollbackIndexes.push(index);

    const statementHazard = classifyStatementHazard(statement, { allowExactFinalRollback: statementIsFinalRollback(statement) });
    if (statementHazard) hazards.push({ code: statementHazard, line: statement.line, column: statement.column });
    for (const call of calledFunctions(statement.tokens)) {
      const code = classifyFunctionHazard(call.name);
      if (code) hazards.push({ code, line: call.line, column: call.column });
    }
    hazards.push(...inspectDoStatement(statement));
  });

  if (!beginIndexes.length) reasons.push('missing_begin');
  if (beginIndexes.length > 1) reasons.push('multiple_begin');
  const beginIndex = beginIndexes[0] ?? -1;
  if (beginIndex >= 0) {
    for (let index = 0; index < beginIndex; index += 1) {
      if (!statementIsPrelude(statements[index])) reasons.push('statement_before_begin');
    }
  }

  if (!finishIndexes.length) reasons.push('missing_finish');
  if (finishIndexes.length > 1) reasons.push('multiple_finish');
  if (!rollbackIndexes.length) reasons.push('missing_final_rollback');
  if (rollbackIndexes.length > 1) reasons.push('multiple_final_rollback');
  const rollbackIndex = rollbackIndexes.length ? rollbackIndexes[rollbackIndexes.length - 1] : -1;
  if (rollbackIndex >= 0) {
    if (!statements[rollbackIndex].terminated) reasons.push('final_rollback_not_terminated');
    if (rollbackIndex !== statements.length - 1) reasons.push('statement_after_final_rollback');
    if (finishIndexes.length === 1 && finishIndexes[0] !== rollbackIndex - 1) reasons.push('finish_not_final_before_rollback');
  }
  if (beginIndex >= 0 && rollbackIndex >= 0 && beginIndex >= rollbackIndex) reasons.push('invalid_transaction_order');
  for (const hazard of hazards) reasons.push(hazard.code);
  if (policyQuarantine) reasons.push(policyQuarantine.quarantine_reason);

  const normalizedReasons = uniqueSortedCodes(reasons);
  const normalizedHazards = sortHazards(hazards);
  const eligible = !policyQuarantine && normalizedReasons.length === 0;
  return {
    file,
    scannerVersion: ISOLATION_SCANNER_VERSION,
    sourceSha256: sourceDigest,
    isolationState: eligible ? 'logical_transaction_isolation_verified' : 'quarantined',
    eligible,
    reasons: normalizedReasons,
    hazards: normalizedHazards,
    transaction: {
      beginCount: beginIndexes.length,
      finishCount: finishIndexes.length,
      finalRollback: rollbackIndex === statements.length - 1 && rollbackIndex >= 0,
    },
    policy: { quarantined: Boolean(policyQuarantine), cleanupEquivalenceApproved: false },
  };
}

function parallelHazard(code, statement, detail = '') {
  return {
    code,
    line: Number(statement?.line || 0),
    column: Number(statement?.column || 0),
    source: 'top_level',
    detail: String(detail || '').slice(0, 160),
  };
}

function statementWords(statement) {
  return (statement.tokens || [])
    .filter((token) => token.type === 'identifier')
    .map((token) => token.value);
}

function acceptedUniqueFixtureMetadata(file, sourceDigest, policy) {
  const entry = policy.uniqueFixtureByFile?.[file];
  return entry && entry.state === 'cos_accepted' && entry.source_sha256 === sourceDigest ? entry : null;
}

function analyzeFocusedPgtapParallelEligibility(options = {}) {
  const file = normalizeRequestedFocusedFile(options.file);
  const source = String(options.source == null ? '' : options.source);
  const sourceDigest = sha256(source);
  const policy = options.policy;
  const isolation = options.isolation || analyzeFocusedPgtapIsolation({ file, source, policy });
  if (!policy?.parallelEligibility || !policy?.uniqueFixtureByFile) {
    throw new Error('Focused parallel eligibility requires validated policy metadata.');
  }
  if (isolation.file !== file || isolation.sourceSha256 !== sourceDigest) {
    throw new Error('Focused parallel eligibility isolation evidence is not bound to the selected file digest.');
  }

  const lexed = lexSqlForIsolation(source);
  const statements = splitTopLevelSqlStatements(lexed);
  const hazards = [];
  const uniqueFixture = acceptedUniqueFixtureMetadata(file, sourceDigest, policy);
  const ddlWords = new Set(['create', 'alter', 'drop', 'truncate', 'comment', 'grant', 'revoke', 'security']);
  const writeWords = new Set(['insert', 'update', 'delete', 'merge']);
  const backgroundPrefixes = /^(?:dblink|pg_background|http_|net\.http_|cron\.)/u;
  const sequenceFunctions = new Set(['nextval', 'currval', 'lastval', 'setval']);
  const safeFunctions = new Set(policy.parallelEligibility.safe_function_allowlist || []);

  if (isolation.isolationState !== 'logical_transaction_isolation_verified' || isolation.eligible !== true) {
    hazards.push(parallelHazard('non_rollback', null, 'logical transaction isolation was not verified'));
  }
  for (const error of lexed.errors) hazards.push(parallelHazard('dynamic_sql_unresolved', error, error.code));
  for (const meta of lexed.metaCommands) hazards.push(parallelHazard('dynamic_sql_unresolved', meta, meta.code));

  for (const statement of statements) {
    const words = statementWords(statement);
    const first = words[0] || '';
    const second = words[1] || '';
    const compact = compactStatement(statement);
    if (ddlWords.has(first)) hazards.push(parallelHazard('ddl', statement, [first, second].filter(Boolean).join(' ')));
    if (ddlWords.has(first) && second === 'sequence') hazards.push(parallelHazard('sequences', statement, first + ' sequence'));
    if (first === 'set' && second !== 'local') hazards.push(parallelHazard('global_settings', statement, 'session or global SET'));
    if (first === 'reset' || (first === 'discard' && second === 'all')) {
      hazards.push(parallelHazard('global_settings', statement, first + (second ? ' ' + second : '')));
    }
    if (first === 'lock' || (first === 'select' && /for(?:update|share|nokeyupdate|keyshare)/u.test(compact))) {
      hazards.push(parallelHazard('advisory_or_global_locks', statement, 'explicit relation or row lock'));
    }
    if (new Set(['listen', 'unlisten', 'notify']).has(first)) {
      hazards.push(parallelHazard('background_workers', statement, first));
    }
    if (first === 'do' || first === 'call' || first === 'execute' || first === 'prepare') {
      hazards.push(parallelHazard('dynamic_sql_unresolved', statement, first));
    }
    if (first === 'copy') {
      hazards.push(parallelHazard('external_side_effect', statement, 'COPY is not parallel eligible'));
    }
    const writeStatement = writeWords.has(first) || (first === 'with' && /(?:insertinto|update[a-z_]|deletefrom|mergeinto)/u.test(compact));
    if (writeStatement && !uniqueFixture) {
      hazards.push(parallelHazard('shared_fixed_rows', statement, first));
      hazards.push(parallelHazard('non_unique_fixtures', statement, 'no accepted unique fixture namespace'));
    }

    for (const call of calledFunctions(statement.tokens)) {
      const base = call.name.split('.').pop();
      if (sequenceFunctions.has(base)) hazards.push(parallelHazard('sequences', call, call.name));
      if (/^pg_(?:try_)?advisory_(?:xact_)?lock(?:_shared)?$/u.test(base)) {
        hazards.push(parallelHazard('advisory_or_global_locks', call, call.name));
      }
      if (backgroundPrefixes.test(call.name) || /^pg_(?:terminate_backend|cancel_backend|reload_conf|promote|rotate_logfile)$/u.test(base)) {
        hazards.push(parallelHazard('background_workers', call, call.name));
      }
      if (/^(?:lo_import|lo_export|pg_logical_emit_message)$/u.test(base) || /^pg_(?:create|drop)_.*replication_slot$/u.test(base)) {
        hazards.push(parallelHazard('external_side_effect', call, call.name));
      }
      if (base === 'set_config' && !/,true\)$/u.test(compact)) {
        hazards.push(parallelHazard('global_settings', call, 'set_config was not proven transaction-local'));
      }
      if (!safeFunctions.has(base)) {
        hazards.push(parallelHazard('dynamic_sql_unresolved', call, call.name + ' is not in the policy safe-function allowlist'));
      }
      if (new Set(['throws_ok', 'lives_ok', 'performs_ok', 'results_eq', 'set_eq', 'bag_eq']).has(base)) {
        hazards.push(parallelHazard('dynamic_sql_unresolved', call, call.name + ' executes SQL not proven side-effect free'));
      }
    }
  }

  const normalizedHazards = [];
  const seen = new Set();
  for (const hazard of hazards.sort((left, right) => compareAscii(canonicalJson(left), canonicalJson(right)))) {
    const key = canonicalJson(hazard);
    if (!seen.has(key)) {
      seen.add(key);
      normalizedHazards.push(hazard);
    }
  }
  const hazardClasses = [...new Set(normalizedHazards.map((hazard) => hazard.code))].sort(compareAscii);
  for (const hazardClass of hazardClasses) {
    if (!policy.parallelEligibility.hazard_classes.includes(hazardClass)) {
      throw new Error('Focused parallel eligibility produced an ungoverned hazard class: ' + hazardClass);
    }
  }
  const eligible = hazardClasses.length === 0;
  return {
    file,
    scannerVersion: ISOLATION_SCANNER_VERSION,
    sourceSha256: sourceDigest,
    parallelState: eligible ? 'parallel_eligible' : 'serial_quarantine_required',
    eligible,
    serialExecutionRequired: !eligible,
    hazardClasses,
    hazards: normalizedHazards,
    fixtureIsolation: uniqueFixture
      ? {
        state: 'cos_accepted_unique_fixture_namespace',
        namespace: uniqueFixture.fixture_namespace,
        evidenceRef: uniqueFixture.evidence_ref,
        artifactSha256: uniqueFixture.artifact_sha256,
      }
      : { state: 'no_unique_fixture_metadata' },
    isolationState: isolation.isolationState,
  };
}
module.exports = {
  analyzeMigrationReplay,
  analyzeFocusedPgtapParallelEligibility,
  analyzeFocusedPgtapIsolation,
  lexSqlForIsolation,
  splitTopLevelSqlStatements,
};
