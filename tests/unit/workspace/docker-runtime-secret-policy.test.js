const { isSensitiveCredentialKey, isSensitiveRuntimeAssignment, normalizeSensitiveKey } = require('../../../scripts/ops/workspace/docker-runtime/secret-policy');
const { redactRuntimeOutput, scanSecretText } = require('../../../scripts/ops/workspace/docker-runtime/redaction');
const { buildRuntimeEvidencePayload } = require('../../../scripts/ops/workspace/docker-runtime/security-scan');

test.each([
  ['_authToken', 'AUTH_TOKEN'],
  ['npm error _authToken', 'NPM_ERROR_AUTH_TOKEN'],
  ['apiKey', 'API_KEY'],
  ['APIKey', 'API_KEY'],
  ['clientSecret', 'CLIENT_SECRET'],
  ['PGPASSWORD', 'PGPASSWORD'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
])('canonical credential classification recognizes %s without losing word boundaries', (key, normalized) => {
  expect(normalizeSensitiveKey(key)).toBe(normalized);
  expect(isSensitiveCredentialKey(key)).toBe(true);
});

test.each(['_authToken', 'apiKey', 'clientSecret'])('shared runtime scanner and redactor agree on %s assignments', key => {
  const source = `npm error ${key}=synthetic-private-value`;
  expect(scanSecretText(source).some(finding => finding.id === 'secret_assignment')).toBe(true);
  const redacted = redactRuntimeOutput(source);
  expect(redacted).not.toContain('synthetic-private-value');
  expect(redacted).toContain('[redacted]');
  expect(scanSecretText(redacted)).toEqual([]);
});

test.each(['taskCount', 'workflowStatus', 'requestId'])('ordinary diagnostic metadata %s stays readable', key => {
  expect(isSensitiveCredentialKey(key)).toBe(false);
  expect(redactRuntimeOutput(`${key}=ready`)).toBe(`${key}=ready`);
});

describe('serialized exact-bound runtime metadata', () => {
  test.each([
    ['POSIX', '/tmp/masarx-synthetic/auth-password.txt', value => JSON.stringify(value)],
    ['Windows', String.raw`C:\masarx-synthetic\auth-password.txt`, value => JSON.stringify(value)],
    ['escaped quote', String.raw`C:\masarx-"synthetic"\auth-password.txt`, value => JSON.stringify(value)],
    ['Unicode escape', String.raw`C:\masarx-synthetic\auth-password.txt`, value => JSON.stringify(value).replace('C', '\\u0043')],
  ])('admits only the canonical %s JSON string without changing its identity', (_label, value, encode) => {
    const plan = { artifacts: { auth_password_file: value } };
    const options = { expectedSafeMetadataValues: { AUTH_PASSWORD_FILE: value } };
    const source = `{"auth_password_file":${encode(value)},"status":"ready"}`;
    expect(isSensitiveRuntimeAssignment('auth_password_file', value, options)).toBe(false);
    expect(scanSecretText(source, options)).toEqual([]);
    expect(redactRuntimeOutput(source, options)).toBe(source);
    expect(JSON.parse(source).auth_password_file).toBe(value);
    expect(buildRuntimeEvidencePayload('summary', source, plan)).toMatchObject({ text: source, findings: [] });
  });

  const canonical = String.raw`C:\masarx-synthetic\auth-password.txt`;
  test.each([
    ['unbound', canonical, {}],
    ['different path', String.raw`C:\other-synthetic\auth-password.txt`, { AUTH_PASSWORD_FILE: canonical }],
    ['slash-normalized spoof', canonical.replace(/\\/g, '/'), { AUTH_PASSWORD_FILE: canonical }],
    ['literal doubled backslashes', canonical.replace(/\\/g, '\\\\'), { AUTH_PASSWORD_FILE: canonical }],
    ['leading whitespace', ' ' + canonical, { AUTH_PASSWORD_FILE: canonical }],
    ['non-path expected value', 'synthetic-private-value', { AUTH_PASSWORD_FILE: 'synthetic-private-value' }],
  ])('rejects and redacts %s JSON metadata', (_label, value, expectedSafeMetadataValues) => {
    const source = JSON.stringify({ auth_password_file: value, status: 'ready' });
    const options = { expectedSafeMetadataValues };
    expect(scanSecretText(source, options)).toEqual([{ id: 'secret_assignment', count: 1 }]);
    const redacted = redactRuntimeOutput(source, options);
    expect(JSON.parse(redacted)).toEqual({ auth_password_file: '[redacted]', status: 'ready' });
    expect(scanSecretText(redacted, options)).toEqual([]);
    const evidence = buildRuntimeEvidencePayload('summary', source, {
      artifacts: { auth_password_file: expectedSafeMetadataValues.AUTH_PASSWORD_FILE },
    });
    expect(evidence.findings).toEqual([{ id: 'secret_assignment', count: 1, kind: 'summary', file: 'summary:inline' }]);
    expect(JSON.parse(evidence.text).auth_password_file).toBe('[redacted]');
  });

  test.each([
    String.raw`"C:\masarx-synthetic\auth-password.txt"`,
    String.raw`"C:\\masarx-\uZZZZ\\auth-password.txt"`,
    String.raw`"C:\\masarx-synthetic\\auth-password.txt`,
    JSON.stringify(canonical) + 'suffix',
  ])('fails closed on malformed JSON string encoding %s', encoded => {
    const source = `{"auth_password_file":${encoded}}`;
    const options = { expectedSafeMetadataValues: { AUTH_PASSWORD_FILE: canonical } };
    expect(scanSecretText(source, options)).toEqual([{ id: 'secret_assignment', count: 1 }]);
    expect(redactRuntimeOutput(source, options)).toBe('{"auth_password_file":"[redacted]"}');
    expect(scanSecretText(redactRuntimeOutput(source, options), options)).toEqual([]);
  });

  test('redacts a complete escaped JSON credential and retains valid neighboring JSON', () => {
    const value = 'synthetic-private"tail\\part';
    const source = JSON.stringify({ api_key: value, status: 'ready' });
    expect(scanSecretText(source)).toEqual([{ id: 'secret_assignment', count: 1 }]);
    const redacted = redactRuntimeOutput(source);
    expect(JSON.parse(redacted)).toEqual({ api_key: '[redacted]', status: 'ready' });
    expect(redacted).not.toContain('tail');
    expect(scanSecretText(redacted)).toEqual([]);
  });

  test('JSON decoding does not exempt an encoded unbound credential as numeric metadata', () => {
    const source = String.raw`{"api_key":"\u0031\u0032\u0033\u0034\u0035\u0036"}`;
    expect(scanSecretText(source)).toEqual([{ id: 'secret_assignment', count: 1 }]);
    expect(JSON.parse(redactRuntimeOutput(source))).toEqual({ api_key: '[redacted]' });
  });

  test('preserves literal single-quoted and bare assignments without JSON unescaping', () => {
    const options = { expectedSafeMetadataValues: { AUTH_PASSWORD_FILE: canonical } };
    for (const source of [
      `'auth_password_file':'${canonical}'`,
      `AUTH_PASSWORD_FILE=${canonical}`,
    ]) {
      expect(scanSecretText(source, options)).toEqual([]);
      expect(redactRuntimeOutput(source, options)).toBe(source);
    }
    const doubled = canonical.replace(/\\/g, '\\\\');
    for (const source of [
      `'auth_password_file':'${doubled}'`,
      `AUTH_PASSWORD_FILE=${doubled}`,
      "'api_key':'synthetic-private-value'",
      'API_KEY=synthetic-private-value',
      'api_key: synthetic-private-value',
    ]) {
      expect(scanSecretText(source, options)).toEqual([{ id: 'secret_assignment', count: 1 }]);
      expect(redactRuntimeOutput(source, options)).toContain('[redacted]');
      expect(scanSecretText(redactRuntimeOutput(source, options), options)).toEqual([]);
    }
  });
});
