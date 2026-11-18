'use strict';
const credentialName = /(?:key|token|password|passwd|secret|credential|authorization|cookie|session(?:_?id)?|sid|jwt|(?:db|database)_?url|connection_?string|dsn)/i;
function environmentSecrets(env = process.env) {
  return Object.entries(env).filter(([key, value]) => credentialName.test(key) && typeof value === 'string' && value.length >= 8).map(([, value]) => value);
}
function sanitize(value, secrets = environmentSecrets()) {
  let text = String(value ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/\b(?:postgres(?:ql)?|mysql|redis(?:s)?|mongodb(?:\+srv)?):\/\/[^\s<>"'`]+/gi, '[REDACTED_CONNECTION]')
    .replace(/\bhttps?:\/\/[^\s/@]+:[^\s/@]+@[^\s<>"'`]+/gi, '[REDACTED_CONNECTION]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9_+/=.-]+/gi, '[REDACTED_AUTH]')
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
    .replace(/\b(?:sb_(?:secret|publishable)_|gh[pousr]_|github_pat_|sk[-_](?:live_|test_|proj-)?)[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/\b([A-Za-z0-9_.-]*(?:key|token|password|passwd|secret|credential|authorization|cookie|session(?:_?id)?|sid|jwt|(?:db|database)_?url|connection_?string|dsn)[A-Za-z0-9_.-]*["']?\s*[:=|│]\s*)(?:\[REDACTED(?:_[A-Z]+)?\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;|│\[\]{}()]+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:[^=\s&]*(?:key|token|password|secret|credential|signature|sig))=)[^\s&#"']+/gi, '$1[REDACTED]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[REDACTED_OPAQUE]')
    .replace(/\b(?=[A-Za-z0-9_+/=-]*[A-Z])(?=[A-Za-z0-9_+/=-]*[a-z])(?=[A-Za-z0-9_+/=-]*[0-9])[A-Za-z0-9_+/=-]{32,}/g, '[REDACTED_OPAQUE]');
}
function outputTail(value, secrets, lines = 80, bytes = 16384) {
  return sanitize(value, secrets).split(/\r?\n/).slice(-lines).join('\n').slice(-bytes);
}
function failureDetails(result, secrets) {
  return { exitCode: result.status ?? null, signal: result.signal ?? null,
    timeout: result.error?.code === 'ETIMEDOUT', errorCode: result.error?.code || null,
    outputTail: outputTail(`${result.stdout || ''}\n${result.stderr || ''}`, secrets) };
}
module.exports = { sanitize, environmentSecrets, outputTail, failureDetails };
