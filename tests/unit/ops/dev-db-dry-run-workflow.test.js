const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const yaml = require('yaml');

const workflowDir = path.resolve(__dirname, '../../../.github/workflows');
const workflow = yaml.parse(fs.readFileSync(path.join(workflowDir, 'deploy.yml'), 'utf8'));
const job = workflow.jobs['database-dry-run'];
const measure = job.steps.find(step => step.id === 'measure');
const fixtureRef = 'abcdefghijklmnopqrst';

test('runs one manual dry-run job in dev with only read access and pinned GitHub actions', () => {
  expect(workflow.on.push).toEqual({ branches: ['dev', 'main'] });
  expect(job.if).toBe("github.event_name == 'workflow_dispatch' && inputs.mode == 'dry-run'");
  const inputs = workflow.on.workflow_dispatch.inputs;
  expect(inputs.mode).toMatchObject({ type: 'choice', required: true, default: 'deploy', options: ['deploy', 'dry-run'] });
  expect(inputs.project_ref).toMatchObject({ type: 'string' });
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(Object.keys(workflow.jobs)).toHaveLength(7);
  expect(job.permissions).toBeUndefined();
  expect(job.environment).toBe('dev');
  expect(job['timeout-minutes']).toBeGreaterThan(45);
  expect(job.concurrency).toEqual({ group: 'dev-db-dry-run', 'cancel-in-progress': false });
  expect(job.concurrency.group).not.toBe(workflow.jobs.database.concurrency.group);
  expect(job.steps.filter(step => step.uses).map(step => step.uses)).toEqual([
    expect.stringMatching(/^actions\/checkout@[a-f0-9]{40}$/),
  ]);
});

test('keeps deploy and its summary on push and on the normal dispatch mode', () => {
  const deployCondition = "github.event_name == 'push' || inputs.mode == 'deploy'";
  expect(workflow.jobs.database.if).toBe(deployCondition);
  expect(workflow.jobs.summary.if).toBe(`\${{ always() && (${deployCondition}) }}`);
  for (const target of ['console', 'portal', 'landing', 'ingress']) {
    expect(workflow.jobs[target].needs).toBe('database');
    expect(workflow.jobs[target].if).toContain("needs.database.result == 'success'");
  }
});

test('rejects other modes and masks the dispatch ref before exporting it', () => {
  const guard = job.steps[0];
  expect(guard.id).toBe('guard');
  expect(guard.if).toBeUndefined();
  expect(guard.env).toEqual({
    MODE: '${{ inputs.mode }}',
    TARGET_MATCHES_DEV: "${{ vars.SUPABASE_PROJECT_REF == '' || vars.SUPABASE_PROJECT_REF == inputs.project_ref }}",
  });
  expect(guard.run).toMatch(/if \[\[ "\$MODE" != dry-run \]\]; then\n[^\n]+\n\s+exit 1\nfi/);
  expect(guard.run).toContain('.inputs.project_ref');
  expect(guard.run).toContain('"$GITHUB_EVENT_PATH"');
  expect(guard.run).toMatch(/::add-mask::%s[\s\S]+>> "\$GITHUB_ENV"/);
  expect(measure.if).toBeUndefined();
});

test('accepts only project refs with exactly 20 lowercase letters', () => {
  const [, encodedPattern] = job.steps[0].run.match(/select\(test\(("(?:\\.|[^"\\])*")\)\)/);
  const jqPattern = JSON.parse(encodedPattern);
  // Translate jq's absolute anchors for JavaScript, including the final newline case.
  const projectRef = new RegExp(jqPattern.replace(/^\\A/, '^').replace(/\\z$/, '(?![\\s\\S])'), 'u');
  expect(fixtureRef).toMatch(projectRef);
  for (const invalid of [
    fixtureRef.slice(1), `${fixtureRef}u`, fixtureRef.toUpperCase(), `${fixtureRef.slice(1)}1`,
    `https://${fixtureRef}.supabase.co`, `${fixtureRef}\n`,
  ]) {
    expect(invalid).not.toMatch(projectRef);
  }
});

test('copies the deploy CLI pin and link command, and always pushes with dry-run enabled', () => {
  const deploy = workflow.jobs.database;
  const deployInstall = deploy.steps.find(step => step.name === 'Prepare edge packages and pinned CLI');
  const dryRunInstall = job.steps.find(step => step.name === 'Install pinned Supabase CLI');
  expect(deployInstall.run).toContain(dryRunInstall.run);
  const deployStep = deploy.steps.find(step => step.id === 'deploy');
  const link = deployStep.run.split('\n').find(line => line.includes(' link --project-ref '));
  expect(link).toBeDefined();
  expect(measure.run).toContain(`if ${link} > /dev/null 2>&1; then`);
  expect(measure.env).toEqual(deployStep.env);
  expect(measure.env.SUPABASE_PROJECT_REF).toBe("${{ inputs.mode != 'dry-run' && vars.SUPABASE_PROJECT_REF || '' }}");
  expect(measure.run).toContain('unset SUPABASE_JWT_SECRET');
  expect(measure.run).toContain('export SUPABASE_PROJECT_REF="$DEV_DRY_RUN_PROJECT_REF"');
  expect(measure.run).toMatch(/if \[\[ -z "\$SUPABASE_ACCESS_TOKEN" \|\| -z "\$SUPABASE_DB_PASSWORD" \]\]; then\n[^\n]+\n\s+exit 1/);
  const commands = job.steps.map(step => step.run || '').join('\n');
  expect(commands).not.toMatch(/\b(?:db\s+reset|migration\s+repair)\b|--include-(?:seed|all|roles)\b/);
  const pushes = commands.split('\n')
    .map(line => line.trim()).filter(line => /\bdb\s+push\b/.test(line));
  expect(pushes).toEqual(['"$cli" db push --dry-run --linked > "$output" 2>&1 || status=$?']);
});

function summarize(output, status, elapsed, stage = 'dry-run') {
  const write = jest.fn();
  const error = jest.fn();
  const log = jest.fn();
  const process = {
    argv: ['node', '-', 'output', stage, String(status), String(elapsed)],
    env: {
      GITHUB_STEP_SUMMARY: 'summary',
      SUPABASE_PROJECT_REF: fixtureRef,
      SUPABASE_DB_PASSWORD: 'fake-password',
    },
  };
  const script = measure.run.split("<<'NODE'\n")[1].split('\nNODE\n')[0];
  runInNewContext(script, {
    require: () => ({ readFileSync: () => output, appendFileSync: write }),
    console: { error, log },
    process,
  }, { timeout: 1000 });
  expect(write).toHaveBeenCalledWith('summary', expect.any(String));
  return { text: write.mock.calls[0][1], errors: error.mock.calls.flat().join('\n'), logs: log.mock.calls.flat(), code: process.exitCode };
}

test('summarizes the pending migration range and flags a run over 45 minutes', () => {
  const { text, logs, code } = summarize([
    'Connecting to remote database...',
    'Would push these migrations:',
    ' • 20260101000000_first.sql',
    ' • 20260102000000_second.sql',
    ' • 20260103000000_last.sql',
  ].join('\n'), 0, 2701);
  expect(text).toContain('Migrations that would be applied: 3');
  expect(text).toContain('First migration: `20260101000000_first.sql`');
  expect(text).toContain('Last migration: `20260103000000_last.sql`');
  expect(text).toContain('Elapsed seconds (link and dry run): 2701');
  expect(text).toContain('exceeded the 45-minute');
  expect(logs).toEqual([
    'dry-run: migrations=3 first=20260101000000_first.sql last=20260103000000_last.sql order=none elapsed=2701s over_45_min=true',
  ]);
  expect(code).toBeUndefined();
});

test('reports a confirmed empty plan and rejects an unrecognized success response', () => {
  const empty = summarize('Remote database is up to date.\n', 0, 2700);
  expect(empty.text).toContain('Migrations that would be applied: 0');
  expect(empty.text).toContain('First migration: None');
  expect(empty.text).toContain('Last migration: None');
  expect(empty.text).not.toContain('exceeded the 45-minute');
  expect(empty.logs).toEqual(['dry-run: migrations=0 first=None last=None order=none elapsed=2700s over_45_min=false']);
  expect(empty.code).toBeUndefined();
  const unknown = summarize('Unexpected output\n', 0, 2);
  expect(unknown.text).toContain('Migrations that would be applied: Unknown');
  expect(unknown.logs).toEqual(['dry-run: migrations=Unknown first=Unknown last=Unknown order=unknown elapsed=2s over_45_min=false']);
  expect(unknown.code).toBe(1);
});

test('logs the same redacted migration range as the summary', () => {
  const { text, errors, logs } = summarize([
    'Would push these migrations:',
    ` • 20260101000000_${fixtureRef}.sql`,
    ' • 20260102000000_fake-password.sql',
    'Connecting to db.example.test...',
  ].join('\n'), 0, 7);
  expect(text).toContain('First migration: Redacted\n- Last migration: Redacted');
  expect(logs).toEqual(['dry-run: migrations=2 first=Redacted last=Redacted order=none elapsed=7s over_45_min=false']);
  expect([text, errors, ...logs].join('\n')).not.toMatch(new RegExp(`${fixtureRef}|fake-password|db\\.example\\.test`));
});

test('reports out-of-order migration details without emitting project identifiers or secrets', () => {
  const result = summarize([
    'Found local migration files to be inserted before the last migration on remote database.',
    'Rerun the command with --include-all flag to apply these migrations:',
    'supabase/migrations/20260101000000_older.sql',
    `supabase/migrations/20260102000000_${fixtureRef}.sql`,
    'supabase/migrations/20260103000000_fake-password.sql',
    `https://${fixtureRef}.supabase.co`,
  ].join('\n'), 1, 3);
  expect(result.text).toContain('Migrations that would be applied: Unknown');
  expect(result.text).toContain('Out of order');
  expect(result.text).toContain('  - `20260101000000_older.sql`\n  - Redacted\n  - Redacted');
  expect(result.logs).toEqual([
    'dry-run: migrations=Unknown first=Unknown last=Unknown order=out-of-order elapsed=3s over_45_min=false',
    'dry-run: out_of_order=20260101000000_older.sql,Redacted,Redacted',
  ]);
  const output = [result.text, result.errors, ...result.logs].join('\n');
  expect(output).not.toContain(fixtureRef);
  expect(output).not.toMatch(/fake-password|https:\/\//);
  expect(result.code).toBe(1);
});

test('reports missing local migration history and records link failures separately', () => {
  const missing = summarize('Remote migration versions not found in local migrations directory.\n', 1, 8);
  expect(missing.text).toContain('Remote migration versions are missing from the local migrations directory.');
  expect(missing.text).toContain('Migrations that would be applied: Unknown');
  expect(missing.logs).toEqual(['dry-run: migrations=Unknown first=Unknown last=Unknown order=missing-local elapsed=8s over_45_min=false']);
  expect(missing.code).toBe(1);
  const link = summarize('', 2, 4, 'link');
  expect(link.text).toContain('Link failed.');
  expect(link.text).toContain('Elapsed seconds (link and dry run): 4');
  expect(link.code).toBe(2);
});
