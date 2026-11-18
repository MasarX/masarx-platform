const fs = jest.requireActual('fs');
const path = jest.requireActual('path');
const vm = jest.requireActual('vm');

const source = fs.readFileSync(path.join(__dirname, '../../integration/fieldops/fieldops-pickup-execution.test.js'), 'utf8');
const progressSource = source.slice(source.indexOf('  async function progressWorkflowFully('), source.indexOf('  async function seedPickupRouteStopTask('));
const seedSource = source.slice(source.indexOf('  async function seedPickupRouteStopTask('), source.indexOf('  async function executeUiCommand('));
const workflowDdl = fs.readFileSync(path.join(__dirname, '../../../supabase/migrations/202510110005_communications.sql'), 'utf8');

const workflowRunDefinition = workflowDdl.match(/CREATE TABLE workflow_runs \(([\s\S]*?)\n\);/)[1];
const workflowRunColumns = new Set([...workflowRunDefinition.matchAll(/^\s{4}([a-z_][a-z_0-9]*)\s+/gm)].map((match) => match[1]));

function validateWorkflowRunColumns(sql) {
  for (const [, column] of sql.matchAll(/\bwr\.([a-z_][a-z_0-9]*)\b/g)) {
    if (!workflowRunColumns.has(column)) {
      throw Object.assign(new Error(`column wr.${column} does not exist in canonical workflow_runs DDL`), { code: '42703' });
    }
  }
}

function createFixture(options = {}) {
  const workflow = options.workflow === undefined ? {
    status: 'completed',
    context: { dispatch_tasks: { count: 1, task_ids: ['task-1'] } },
    steps: [{ operation_name: 'task_enqueue_many', status: 'completed' }],
  } : options.workflow;
  let advances = 0;
  let user = 0;
  const queries = [];
  const client = { query: jest.fn(async (sql, args) => {
    queries.push({ sql, args });
    if (sql.includes('progress_workflow_run(')) {
      if (options.progressError) throw options.progressError;
      advances += 1;
      return { rows: [{ result: options.result || (advances === 1
        ? { status: 'completed', step_id: 'fanout-step' }
        : { status: 'completed' }) }] };
    }
    if (sql.includes('FROM workflow_runs wr')) {
      validateWorkflowRunColumns(sql);
      return { rows: workflow ? [workflow] : [] };
    }
    if (sql.includes('SELECT t.id AS task_id')) {
      return { rows: advances ? (options.taskRows || [{ task_id: 'task-1', parent_workflow_run_id: 'wave-1' }]) : [] };
    }
    if (sql.includes('upsert_settings_value_v1')) return { rows: [] };
    throw new Error(`Unexpected fixture query: ${sql}`);
  }) };
  const fixture = vm.runInNewContext(`${options.progressSource || progressSource}\n${seedSource}\n({ progressWorkflowFully, seedPickupRouteStopTask })`, {
    client, expect, randomUUID: () => 'unique-id',
    withFixtureAdminContext: async (_client, operation) => operation(client),
    createOrganization: async () => ({ id: 'org-1' }),
    createClient: async () => ({ id: 'client-1' }),
    createSender: async () => 'sender-1',
    createUser: async () => `user-${++user}`,
    setServiceContext: async () => {},
    createPickupRequest: async () => ({ shipment_id: 'shipment-1' }),
    createPickupWave: async () => ({ stop_ids: ['stop-1'], workflow_run_id: 'wave-1' }),
  });
  return { ...fixture, queries, client };
}

test('one-step wave fixture settles canonical fanout before requiring its exact linked task', async () => {
  const fixture = createFixture();
  const seed = await fixture.seedPickupRouteStopTask();
  expect(seed.routeStopTaskId).toBe('task-1');
  const policyQuery = fixture.queries.find(({ sql }) => sql.includes('upsert_settings_value_v1'));
  expect(policyQuery.args).toEqual(['org-1']);
  expect(policyQuery.sql).toContain("'{wave,inline_max_steps}', '1'::jsonb");
  const taskQuery = fixture.queries.findIndex(({ sql }) => sql.includes('SELECT t.id AS task_id'));
  expect(fixture.queries.slice(0, taskQuery).some(({ sql }) => sql.includes('progress_workflow_run('))).toBe(true);
  expect(fixture.queries[taskQuery].args).toEqual(['org-1', 'stop-1']);
});

test('snapshot uses the real workflow_status column and aliases it for the existing completion guard', async () => {
  expect(workflowRunColumns.has('workflow_status')).toBe(true);
  expect(workflowRunColumns.has('status')).toBe(false);
  const fixture = createFixture();
  await fixture.progressWorkflowFully('wave-1');
  const snapshot = fixture.queries.find(({ sql }) => sql.includes('FROM workflow_runs wr'));
  expect(snapshot.sql).toContain('wr.workflow_status AS status');
});

test('the previous wr.status SQL fails against actual table DDL rather than being accepted by the mock', async () => {
  const previousQuery = progressSource.replace('wr.workflow_status AS status', 'wr.status');
  const fixture = createFixture({ progressSource: previousQuery });
  await expect(fixture.progressWorkflowFully('wave-1')).rejects.toMatchObject({ code: '42703' });
});

test.each([
  [],
  [{ task_id: 'task-1' }, { task_id: 'task-2' }],
  [{ task_id: 'wrong-task', parent_workflow_run_id: 'wave-1' }],
  [{ task_id: 'task-1', parent_workflow_run_id: 'another-wave' }],
].map((taskRows) => [taskRows]))('missing, duplicate or wrongly linked task cannot satisfy the fixture: %j', async (taskRows) => {
  await expect(createFixture({ taskRows }).seedPickupRouteStopTask()).rejects.toThrow();
});

test.each([
  { count: 0, task_ids: [] },
  { count: 1, task_ids: [] },
  { count: 1, task_ids: ['another-task'] },
])('incomplete or inconsistent fanout output cannot pass: %j', async (dispatchTasks) => {
  const fixture = createFixture({ workflow: { status: 'completed', context: { dispatch_tasks: dispatchTasks } } });
  await expect(fixture.seedPickupRouteStopTask()).rejects.toThrow();
});

test.each(['failed', 'cancelled', 'blocked', 'waiting', 'pending', 'in_progress'])('%s progression fails with native result/step diagnostics instead of silently continuing', async (status) => {
  const fixture = createFixture({
    result: { status, step_id: 'fanout-step', next_run_at: '2099-01-01T00:00:00Z', error: 'native-step-reason' },
    workflow: { status, steps: [{ last_error: 'native-step-reason' }] },
  });
  await expect(fixture.progressWorkflowFully('wave-1')).rejects.toThrow(/wave-1.*native-step-reason/);
  expect(fixture.queries.filter(({ sql }) => sql.includes('progress_workflow_run('))).toHaveLength(1);
});

test('exhausting the existing 50-step bound is not completion', async () => {
  const fixture = createFixture({
    result: { status: 'completed', step_id: 'one-step-only' },
    workflow: { status: 'in_progress', steps: [{ status: 'pending' }] },
  });
  await expect(fixture.progressWorkflowFully('wave-1')).rejects.toThrow('Pickup fixture workflow did not settle');
  expect(fixture.queries.filter(({ sql }) => sql.includes('progress_workflow_run('))).toHaveLength(50);
});

test('missing workflow state fails closed', async () => {
  await expect(createFixture({ workflow: null }).progressWorkflowFully('wave-1')).rejects.toThrow('did not settle');
});

test('progression authorization failures propagate without an admin runtime retry', async () => {
  const error = Object.assign(new Error('workflow access denied'), { code: '42501' });
  const fixture = createFixture({ progressError: error });
  await expect(fixture.progressWorkflowFully('wave-1')).rejects.toBe(error);
  expect(fixture.queries).toHaveLength(1);
});

test('a completed workflow can be reobserved without fabricating another task', async () => {
  const fixture = createFixture();
  await fixture.progressWorkflowFully('wave-1');
  await fixture.progressWorkflowFully('wave-1');
  expect(fixture.queries.filter(({ sql }) => sql.includes('progress_workflow_run('))).toHaveLength(3);
  expect(fixture.queries.every(({ sql }) => !/INSERT INTO tasks|UPDATE workflow_runs|UPDATE workflow_run_steps/i.test(sql))).toBe(true);
});
