'use strict';
const credentialName = /(?:key|token|password|passwd|secret|credential|authorization|cookie|session(?:_?id)?|sid|jwt|(?:db|database)_?url|connection_?string|dsn)/i;
const sqlLiteral = String.raw`(?:\bE'(?:\\[\s\S]|''|[^'\\])*'|'(?:''|[^'])*'|(?<tag>\$(?:[a-z_]\w*)?\$)[\s\S]*?\k<tag>)`;
const rolePassword = new RegExp(String.raw`(\b(?:CREATE|ALTER)\s+(?:ROLE|USER)\s+(?:"(?:[^"]|"")*"|[\w$]+)\s+(?:[^;'\r\n]|'(?:''|[^'])*')*?\bPASSWORD\s+)${sqlLiteral}`, 'gi');
const bindParameters = /(\bDETAIL:[ \t]+parameters:[ \t]*)(?=\$\d+[ \t]*=)(?:[^'\r\n]|'(?:''|[^'])*')+/gi;

function redactSqlArguments(text) {
  const calls = /\b(?:vault\s*\.\s*(?:create_secret|update_secret)|crypt|pgp_sym_encrypt|(set_config))\s*\(/gi;
  const tokens = new RegExp(String.raw`(${sqlLiteral})|"(?:[^"]|"")*"|\r?\n(?=\S)|[(),;]`, 'gi');
  let clean = '';
  let cursor = 0;
  for (let call; (call = calls.exec(text));) {
    const argsStart = calls.lastIndex;
    tokens.lastIndex = argsStart;
    let depth = 0;
    let argument = 0;
    let sensitiveSetting = false;
    for (let token; (token = tokens.exec(text));) {
      const value = token[0];
      if (value === '(') depth++;
      if (value === ')' && depth-- === 0) break;
      if (value === ';' || value.endsWith('\n')) break;
      if (call[1] && value === ',' && depth === 0 && ++argument === 2) break;
      if (!token[1]) continue;
      if (call[1] && argument === 0) sensitiveSetting ||= /claims|jwt|token|secret|password/i.test(value);
      else if (!call[1] || sensitiveSetting) {
        clean += text.slice(cursor, token.index) + "'[REDACTED]'";
        cursor = tokens.lastIndex;
      }
    }
    if (cursor > argsStart && tokens.lastIndex) calls.lastIndex = tokens.lastIndex;
  }
  return clean + text.slice(cursor);
}

function environmentSecrets(env = process.env) {
  return Object.entries(env).filter(([key, value]) => credentialName.test(key) && typeof value === 'string' && value.length >= 8).map(([, value]) => value);
}
function sanitize(value, secrets = environmentSecrets()) {
  let text = String(value ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  text = redactSqlArguments(text.replace(rolePassword, "$1'[REDACTED]'").replace(bindParameters, '$1[REDACTED]'));
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/\b(?:postgres(?:ql)?|mysql|redis(?:s)?|mongodb(?:\+srv)?):\/\/[^\s<>"'`]+/gi, '[REDACTED_CONNECTION]')
    .replace(/\bhttps?:\/\/[^\s/@]+:[^\s/@]+@[^\s<>"'`]+/gi, '[REDACTED_CONNECTION]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9_+/=.-]+/gi, '[REDACTED_AUTH]')
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
    .replace(/\b(?:sb_(?:secret|publishable)_|gh[pousr]_|github_pat_|sk[-_](?:live_|test_|proj-)?)[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/\b([A-Za-z0-9_.-]*(?:key|token|password|passwd|secret|credential|authorization|cookie|session(?:_?id)?|sid|jwt|(?:db|database)_?url|connection_?string|dsn)[A-Za-z0-9_.-]*["']?\s*(?:=>|[:=|│])\s*)(?:\[REDACTED(?:_[A-Z]+)?\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;|│\[\]{}()]+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:[^=\s&]*(?:key|token|password|secret|credential|signature|sig))=)[^\s&#"']+/gi, '$1[REDACTED]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[REDACTED_OPAQUE]')
    .replace(/\b(?=[A-Za-z0-9_+/=-]*[A-Z])(?=[A-Za-z0-9_+/=-]*[a-z])(?=[A-Za-z0-9_+/=-]*[0-9])[A-Za-z0-9_+/=-]{32,}/g, '[REDACTED_OPAQUE]');
}
function outputTail(value, secrets, lines = 80, bytes = 16384) {
  const tail = Buffer.from(sanitize(value, secrets).split(/\r?\n/).slice(-lines).join('\n'));
  let start = Math.max(0, tail.length - bytes);
  while ((tail[start] & 0xc0) === 0x80) start++;
  return tail.toString('utf8', start);
}
function failureDetails(result, secrets) {
  return { exitCode: result.status ?? null, signal: result.signal ?? null,
    timeout: result.error?.code === 'ETIMEDOUT', errorCode: result.error?.code || null,
    outputTail: outputTail(`${result.stdout || ''}\n${result.stderr || ''}`, secrets) };
}
module.exports = { sanitize, environmentSecrets, outputTail, failureDetails };
