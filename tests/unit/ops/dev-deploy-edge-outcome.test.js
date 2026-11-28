const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parse } = require('yaml');
const { evaluate } = require('../../../scripts/deploy/apply-guard.cjs');

const { jobs } = parse(readFileSync(resolve(__dirname, '../../../.github/workflows/deploy.yml'), 'utf8'));
const deploy = jobs.database.steps.find(step => step.id === 'deploy');
const completion = jobs.database.steps.find(step => step.id === 'record_apply_completion');

test.each([
  ['Edge publication failed after database apply', 'success', 'allow', 'G2: previous apply at run 42 concluded success'],
  ['database write was attempted and did not complete', 'skipped', 'refused', 'G2: previous apply failed at run 42; re-arm required'],
])('G2 handles a failed deployment when %s', async (_case, conclusion, expected, decision) => {
  const sha = 'a'.repeat(40);
  const replies = {
    '/git/ref/heads/main': { object: { sha } },
    '/actions/workflows/deploy.yml/runs': { workflow_runs: [{ id: 42, run_attempt: 1 }] },
    '/actions/runs/42/attempts/1/jobs': { jobs: [{
      name: 'database', status: 'completed', conclusion: 'failure', completed_at: '2026-01-01T00:00:00Z',
      steps: [
        { name: deploy.name, conclusion: 'failure' },
        { name: 'Record database push attempt', conclusion: 'success' },
        { name: completion.name, conclusion },
      ],
    }] },
  };
  const record = jest.fn();
  const get = path => replies[path.split('?')[0]];
  const env = { GITHUB_SHA: sha, GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ID: '43', GITHUB_RUN_ATTEMPT: '1' };

  await expect(evaluate(get, env, record)).resolves.toBe(expected);
  expect(record).toHaveBeenCalledWith(decision);
});

test('records database completion before publishing Edge and keeps a failed upload fatal to Console promotion', () => {
  const checkpoint = deploy.run.indexOf(`printf 'apply_completed=true\\n' >> "$GITHUB_OUTPUT"`);
  const sync = deploy.run.indexOf('bash scripts/deploy/sync-outbound-wake-endpoint.sh');
  expect(sync).toBeGreaterThan(deploy.run.indexOf('"$cli" db push --linked'));
  expect(checkpoint).toBeGreaterThan(sync);
  expect(deploy.run.indexOf('"$cli" functions deploy')).toBeGreaterThan(checkpoint);
  expect(completion.if).toBe("${{ always() && steps.deploy.outputs.apply_completed == 'true' }}");
  expect(deploy['continue-on-error']).toBeUndefined();
  expect(jobs.database.outputs.edge_publication).toContain('steps.deploy.outcome');
  expect(jobs.console.if).toContain("needs.database.result == 'success'");
});
