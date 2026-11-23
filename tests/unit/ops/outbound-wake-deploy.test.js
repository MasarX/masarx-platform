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
  ['already matches', 't', 't', 0, ['read', 'endpoint_matches_expected=true']],
  ['differs, then matches', 'f', 't', 0, ['read', 'write', 'read', 'endpoint_matches_expected=true']],
  ['read-back differs', 'f', 'f', 1, ['read', 'write', 'read', 'endpoint_matches_expected=false']],
])('deploy sync handles %s', (_name, before, after, status, output) => {
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
      local sql
      sql=$(cat)
      [[ "$OUTBOUND_WAKE_ENDPOINT" == "$EXPECTED_ENDPOINT" && "$PGHOST" == "$POOLER_HOST" ]] || return 1
      if [[ "$sql" == *public.upsert_settings_value_v1* ]]; then
        [[ "$sql" == *"IS DISTINCT FROM"* && "$sql" == *jsonb_set* ]] || return 1
        printf 'write\n' >&3
        printf 'changed\n' > "$written"
      elif [[ "$sql" == *public.resolve_settings* && "$sql" == *"READ ONLY"* ]]; then
        printf 'read\n' >&3
        if [[ -s "$written" ]]; then printf '%s\n' "$AFTER"; else printf '%s\n' "$BEFORE"; fi
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
    AFTER: after,
  });
  expect(result).toEqual({ status, stdout: `${output.join('\n')}\n`, stderr: '' });
});
