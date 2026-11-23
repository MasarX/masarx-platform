const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const yaml = require('yaml');

const root = path.resolve(__dirname, '../../..');
const workflow = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8'));
const readout = workflow.jobs['api-schemas'].steps.find(step => step.name === 'Read renderer JWT claims').run;
const deploy = workflow.jobs.database.steps.find(step => step.id === 'deploy').run;
const deployCommand = 'bash scripts/deploy/sync-outbound-wake-endpoint.sh';

function runBash(script, env) {
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe')
    : 'bash';
  const result = spawnSync(bash, ['--noprofile', '--norc', '-s'], {
    cwd: root, env: { ...process.env, ...env }, input: script, encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout.replace(/\r/g, ''), stderr: result.stderr };
}

const ready = {
  policy_endpoint_present: true,
  policy_endpoint_matches_relay: true,
  relay_blocked_with_pending_work_count: 3,
};

test.each([
  ['matching, with historical signals', ready, false, 0],
  ['missing with no work', { ...ready, policy_endpoint_present: false, policy_endpoint_matches_relay: false }, false, 0],
  ['missing with work before the first sweep', {
    policy_endpoint_present: false, policy_endpoint_matches_relay: false, relay_blocked_with_pending_work_count: 0,
  }, true, 1],
  ['mismatched with work', { ...ready, policy_endpoint_matches_relay: false }, true, 1],
])('policy readout handles %s', (_name, fields, blocked, status) => {
  const result = runPolicyReadout(JSON.stringify({ ...fields, blocked }));
  expect(result.status).toBe(status);
  expect(result.stderr).toBe('');
  const [previous, policy, summary, end] = result.stdout.trimEnd().split('\n');
  expect(previous).toBe('outbound_wake={}');
  expect(JSON.parse(policy.slice('outbound_wake_policy='.length))).toEqual(fields);
  expect(summary).toBe(blocked ? 'outbound_wake_policy=BLOCKED pending Edge work cannot be woken by the relay' : undefined);
  expect(end).toBeUndefined();
});

test.each([
  ['extra field', JSON.stringify({ ...ready, blocked: false, endpoint: randomUUID() })],
  ['string boolean', JSON.stringify({ ...ready, blocked: 'false' })],
  ['negative count', JSON.stringify({ ...ready, blocked: false, relay_blocked_with_pending_work_count: -1 })],
  ['fractional count', JSON.stringify({ ...ready, blocked: false, relay_blocked_with_pending_work_count: 1.5 })],
  ['missing field', JSON.stringify(ready)],
  ['multiple objects', `${JSON.stringify({ ...ready, blocked: false })}\n${JSON.stringify(ready)}`],
])('policy readout refuses %s without disclosing raw input', (_name, input) => {
  expect(runPolicyReadout(input)).toEqual({
    status: 1,
    stdout: 'outbound_wake={}\noutbound_wake_policy=UNREADABLE reason=validate\n',
    stderr: '',
  });
});

function runPolicyReadout(input) {
  const start = readout.indexOf('wake_policy="$(');
  const query = readout.slice(start, readout.indexOf('renderer_states="$('));
  const previousOutput = readout.slice(readout.lastIndexOf("printf 'outbound_wake=%s", start), start);
  const errorHandler = readout.slice(readout.indexOf('renderer_unreadable()'), readout.indexOf('case "$DEPLOY_ENV'));
  return runBash(`set -euo pipefail
    renderer_psql() { cat >/dev/null; printf '%s\n' "$POLICY_FIXTURE"; }
    ${errorHandler}
    wake_readout='{}'
    ${previousOutput}
    ${query}
  `, { POLICY_FIXTURE: input, GITHUB_STEP_SUMMARY: '/dev/null' });
}

test.each([
  ['already matches', 't', 'false', '', null, true, true],
  ['missing policy', 'f', 'absent', '', 'false', true, true],
  ['matching endpoint without enabled', 't', 'absent', '', 'false', true, true],
  ['keeps explicit true', 'f', 'true', '', 'true', true, true],
  ['keeps explicit false', 'f', 'false', '', 'false', true, true],
  ['read-back endpoint differs', 'f', 'true', 'f|t', 'true', false, true],
  ['read-back enabled is absent', 'f', 'absent', 't|f', 'false', true, false],
  ['refuses malformed explicit enabled', 'f', 'invalid', '', null, false, false],
  ['write SQLSTATE', 'f', 'absent', '', null, false, false, 'sqlstate-40001'],
  ['client failure without SQLSTATE', 'f', 'absent', '', null, false, false, 'psql-exit-2'],
])('deploy sync handles %s', (_name, before, enabled, after, writtenValue, matches, explicit, psqlError = '') => {
  expect(deploy.indexOf(deployCommand)).toBeGreaterThan(deploy.indexOf('"$cli" db push --linked'));
  expect(deploy.indexOf(deployCommand)).toBeLessThan(deploy.indexOf('"$cli" functions deploy'));
  const ref = randomUUID().replace(/-/g, '').slice(0, 20).replace(/[0-9]/g, 'x');
  const result = runBash(`set -euo pipefail
    exec 3>&1
    written=$(mktemp)
    trap 'rm -f "$written"' EXIT
    export written
    curl() {
      case "$*" in
        */config/database/pooler) cat >/dev/null; printf '[{"database_type":"PRIMARY","db_host":"%s"}]\n' "$POOLER_HOST" ;;
      esac
    }
    sha256sum() { cat >/dev/null; }
    timeout() { shift; "$@"; }
    psql() {
      local sql query
      sql=$(cat)
      [[ "$OUTBOUND_WAKE_ENDPOINT" == "$EXPECTED_ENDPOINT" && "$PGHOST" == "$POOLER_HOST" ]] || return 1
      # psql sends a semicolon-terminated query before the next \\bind can bind $1.
      query=\${sql%$'\\n\\\\bind :endpoint\\n\\\\g\\nCOMMIT;'}
      if [[ "$query" == "$sql" || "$query" == *';' ]]; then
        printf 'ERROR:  42P02\\n' >&2
        return 3
      fi
      if [[ "$sql" == *public.upsert_settings_value_v1* ]]; then
        [[ "$sql" == *"IS DISTINCT FROM \\$1::text OR NOT (value ? 'enabled')"* &&
           "$sql" == *"NOT (value ? 'enabled') OR jsonb_typeof(value->'enabled') = 'boolean'"* &&
           "$sql" == *"jsonb_build_object('enabled', false) || changed.value || jsonb_build_object('endpoint_url',"* ]] || return 1
        if [[ -n "$PSQL_ERROR" ]]; then
          printf 'ERROR:  XX000 endpoint=%s password=%s\\n' "$OUTBOUND_WAKE_ENDPOINT" "$PGPASSWORD" >&2
          if [[ "$PSQL_ERROR" == sqlstate-* && " $* " == *' -v VERBOSITY=sqlstate '* ]]; then
            printf 'ERROR:  %s\\n' "\${PSQL_ERROR#sqlstate-}" >&2
            return 3
          fi
          return 2
        fi
        case "$BEFORE_ENABLED" in
          absent) printf 'false\n' > "$written" ;;
          true|false) printf '%s\n' "$BEFORE_ENABLED" > "$written" ;;
          *) return 0 ;;
        esac
        printf 'write:%s\n' "$(cat "$written")" >&3
      elif [[ "$sql" == *public.resolve_settings* && "$sql" == *"READ ONLY"* ]]; then
        [[ "$sql" == *"jsonb_typeof(value->'enabled') = 'boolean'"* ]] || return 1
        printf 'read\n' >&3
        if [[ -s "$written" ]]; then
          printf '%s\n' "\${AFTER:-t|t}"
        elif [[ "$BEFORE_ENABLED" == true || "$BEFORE_ENABLED" == false ]]; then
          printf '%s|t\n' "$BEFORE"
        else
          printf '%s|f\n' "$BEFORE"
        fi
      else
        return 1
      fi
    }
    export -f curl sha256sum timeout psql
    ${deployCommand}
  `, {
    SUPABASE_PROJECT_REF: ref,
    SUPABASE_ACCESS_TOKEN: randomUUID(),
    SUPABASE_DB_PASSWORD: randomUUID(),
    POOLER_HOST: ['aws-0-ci', 'pooler', 'supabase', 'com'].join('.'),
    EXPECTED_ENDPOINT: `https://${[ref, 'supabase', 'co'].join('.')}/functions/v1/api-caller`,
    BEFORE: before,
    BEFORE_ENABLED: enabled,
    AFTER: after,
    PSQL_ERROR: psqlError,
  });
  const output = ['read'];
  if (writtenValue !== null) output.push(`write:${writtenValue}`, 'read');
  if (enabled === 'invalid') output.push('read');
  output.push(`endpoint_matches_expected=${matches}`, `enabled_explicit=${explicit}`);
  expect(result).toEqual({
    status: matches && explicit ? 0 : 1,
    stdout: `${output.join('\n')}\n`,
    stderr: psqlError ? `outbound_wake_sync=FAILED reason=${psqlError}\n` : '',
  });
});
