const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const yaml = require('yaml');

const root = path.resolve(__dirname, '../../..');
const workflow = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8'));
const readout = workflow.jobs['api-schemas'].steps.find(step => step.name === 'Read renderer JWT claims').run;
const [, sql] = readout.match(/if backlog_metrics="\$\(renderer_psql <<'SQL'\n([\s\S]+?)\nSQL\n/);
const backlog = readout.slice(readout.indexOf('if backlog_metrics='), readout.indexOf('wake_metrics='));

test('reads the backlog in one bounded read-only transaction with only catalog functions', () => {
  const statements = sql.replace(/--[^\n]*|'(?:''|[^'])*'/g, '').split(';').map(part => part.trim());
  expect(statements.map(part => part.split(/\s+/)[0])).toEqual(['BEGIN', 'SET', 'SET', 'WITH', 'COMMIT', '']);
  expect(statements[0]).toBe('BEGIN TRANSACTION READ ONLY');
  expect(sql).toContain("SET LOCAL statement_timeout = '8s';\nSET LOCAL search_path = pg_catalog;");
  expect(statements[3]).not.toMatch(/\\|\/\*|\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|REVOKE|MERGE|TRUNCATE|COPY|CALL|DO|INTO|LOCK)\b|\bFOR\s+SHARE\b/i);
  const calls = [...statements[3].matchAll(/\b([\w.]+)\s*\(/g)].map(([, name]) => name.toLowerCase());
  expect([...new Set(calls)].sort()).toEqual([
    'and', 'as', 'coalesce', 'count', 'filter', 'jsonb_agg', 'now', 'or', 'to_jsonb',
  ]);
  expect(sql).toContain("LEFT JOIN public.providers p ON oc.target_type = 'provider' AND oc.target_id = p.id");
});

test('uses the leased claimant due conditions for failures and counts the whole Edge queue', () => {
  const migration = fs.readFileSync(path.join(
    root, 'supabase/migrations/20261123047400_renderer_calls_via_edge.sql',
  ), 'utf8').replace(/\r\n/g, '\n');
  const [, claimant] = migration.match(/CREATE OR REPLACE FUNCTION public\.claim_pending_edge_job_ids_v1\b([\s\S]+?)\n\$function\$;/);
  const [, due] = claimant.match(/WHERE oc\.status IN \('pending_edge', 'failed'\)\n([\s\S]+?)\n    ORDER BY/);
  expect(sql.match(/WHERE oc\.status = 'pending_edge'\n\s+OR \(oc\.status = 'failed'\n([\s\S]+?)\)\n\), counts AS/)[1]
    .replace(/\s+/g, ' ').trim()).toBe(due
    .replace("AND (oc.status <> 'failed' OR oc.retry_count < oc.max_retries)", 'AND oc.retry_count < oc.max_retries')
    .replace(/\s+/g, ' ').trim());
  expect(sql).toContain("count(*) FILTER (WHERE status = 'failed') AS due_failed_count");
  expect(sql).toContain("count(*) FILTER (WHERE status = 'pending_edge') AS pending_edge_count");
});

test('classifies only reserved test hosts in the queued destination or Edge override', () => {
  expect(sql).toContain("CASE WHEN oc.renderer_credential_ref IS NULL THEN oc.context #>> '{edge_dispatch,url}' END");
  expect(sql).toContain('CASE WHEN oc.execution_url_vault_id IS NULL THEN oc.url END');
  const [, pattern] = sql.match(/~\* '([^']+)'\n\s+THEN 'sandbox' ELSE 'unknown'/);
  const sandbox = new RegExp(pattern, 'i');
  const reserved = ['queue', 'invalid'].join('.');
  const example = ['example', 'org'].join('.');
  const other = ['queue', 'synthetic', 'net'].join('.');
  expect(sandbox.test('https://' + reserved + ':8443/v1')).toBe(true);
  expect(sandbox.test('https://api.' + example)).toBe(true);
  for (const target of [
    reserved + '@' + other, other + '/' + reserved, other + '?next=' + example, reserved + '.lookalike',
  ]) {
    expect(sandbox.test('https://' + target)).toBe(false);
  }
});

const row = {
  provider_type: 'webhook', target_class: 'unknown', due_failed_count: 2, pending_edge_count: 3,
};

function runBacklog(input, psqlStatus = 0, psqlError = '') {
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe')
    : 'bash';
  const helpers = readout.slice(readout.indexOf('renderer_psql()'), readout.indexOf('if backlog_metrics='));
  const result = spawnSync(bash, ['--noprofile', '--norc', '-s'], {
    cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { ...process.env, BACKLOG_INPUT: input, PSQL_STATUS: String(psqlStatus), PSQL_ERROR: psqlError },
    input: String.raw`set -euo pipefail
      GITHUB_STEP_SUMMARY=/dev/null
      psql_stderr="$(mktemp)"
      trap 'rm -f "$psql_stderr"' EXIT
      pooler=unused
      ca_file=unused
      SUPABASE_PROJECT_REF=unused
      timeout() {
        [[ "$1" == 20s ]] || return 1
        shift
        "$@"
      }
      psql() {
        cat >/dev/null
        [[ "$PGCONNECT_TIMEOUT" == 8 && " $* " == *' -v VERBOSITY=sqlstate '* ]] || return 1
        printf '%s' "$BACKLOG_INPUT"
        printf '%s' "$PSQL_ERROR" >&2
        return "$PSQL_STATUS"
      }
      ${readout.slice(readout.indexOf('renderer_unreadable()'), readout.indexOf('case "$DEPLOY_ENV'))}
      ${helpers}
      ${backlog}
      printf 'continued\n'
    `,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout.replace(/\r/g, ''), stderr: result.stderr };
}

test('prints only the four safe fields and merges disallowed values into other by class', () => {
  const host = ['provider', 'invalid'].join('.');
  const invalidTypes = [host, 'https://' + host + '/v1', 'private-provider', randomUUID(), null, 17, 'webhook\n'];
  const input = [
    row, { ...row, target_class: 'sandbox' },
    ...invalidTypes.map(provider_type => ({ ...row, provider_type })),
  ];
  const output = [
    { ...row, provider_type: 'other', due_failed_count: 14, pending_edge_count: 21 },
    { ...row, target_class: 'sandbox' },
    row,
  ];
  expect(runBacklog(JSON.stringify(input))).toEqual({
    status: 0, stdout: `outbound_backlog=${JSON.stringify(output)}\ncontinued\n`, stderr: '',
  });
  expect(runBacklog('[]')).toEqual({ status: 0, stdout: 'outbound_backlog=[]\ncontinued\n', stderr: '' });
});

test.each([
  ['extra field', [{ ...row, url: 'https://' + ['provider', 'invalid'].join('.') }]],
  ['invalid target class', [{ ...row, target_class: ['provider', 'invalid'].join('.') }]],
  ['string count', [{ ...row, pending_edge_count: '3' }]],
  ['negative count', [{ ...row, pending_edge_count: -1 }]],
  ['fractional count', [{ ...row, due_failed_count: 1.5 }]],
  ['unsafe sum', [row, { ...row, due_failed_count: Number.MAX_SAFE_INTEGER }]],
  ['missing fields', [{}]],
  ['wrong top-level shape', row],
  ['multiple documents', '[]\n[]'],
])('rejects %s without exposing input or failing the step', (_name, input) => {
  expect(runBacklog(typeof input === 'string' ? input : JSON.stringify(input))).toEqual({
    status: 0, stdout: 'outbound_backlog=UNREADABLE reason=validate\ncontinued\n', stderr: '',
  });
});

test.each([['ERROR:  57014\n', 3, 'sqlstate-57014'], ['', 124, 'psql-exit-124']])(
  'reports query failure using only %s with exit %i',
  (sqlstate, status, reason) => {
    const raw = 'connection detail https://' + ['provider', 'invalid'].join('.') + '\n';
    expect(runBacklog(raw, status, raw + sqlstate)).toEqual({
      status: 0, stdout: `outbound_backlog=UNREADABLE reason=${reason}\ncontinued\n`, stderr: '',
    });
  },
);
