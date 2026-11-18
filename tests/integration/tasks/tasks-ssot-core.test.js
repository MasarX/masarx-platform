const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const {
  DATABASE_URL,
  createOrganization,
  createClient,
  createSender,
  createUser,
  setAuthContext
} = require('../helpers/tenant-utils');

const pool = new Pool({ connectionString: DATABASE_URL });

describe('Tasks SSOT core', () => {
  let client;

  async function setServiceContext(userId, organizationId) {
    await client.query('SET LOCAL ROLE service_role');
    await client.query('SELECT set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({
        role: 'service_role',
        sub: userId,
        organization_id: organizationId,
      })
    ]);
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', String(userId)]);
  }

  beforeAll(async () => {
    const connection = await pool.connect();
    await connection.query('SELECT 1');
    connection.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    client.release();
    client = null;
  });

  it('creates, assigns, and completes tasks idempotently with provenance', async () => {
    const { id: organizationId } = await createOrganization(client, 'Tasks SSOT Org');
    const { id: clientId } = await createClient(client, organizationId, 'Tasks SSOT Client');
    const senderId = await createSender(client, clientId, 'Tasks SSOT Sender');

    const actorId = await createUser(client, organizationId, `task-actor-${randomUUID().slice(0, 8)}@example.com`, {
      accessScopeType: 'tenant'
    });
    const assigneeId = await createUser(
      client,
      organizationId,
      `task-assignee-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );

    await client.query(
      `INSERT INTO task_types (organization_id, key, name, enabled, default_priority, default_queue_key)
       VALUES ($1::uuid, 'delivery', 'Delivery', true, 50, 'default')`,
      [organizationId]
    );

    await setAuthContext(client, actorId);

    const ctx = { organization_id: organizationId, client_id: clientId, sender_id: senderId };
    const createIdempotencyKey = `idem-create-${randomUUID()}`;

    const { rows: createdRows } = await client.query(
      `SELECT *
         FROM public.create_task_v1(
           $1,
           $2::jsonb,
           $3,
           $4::uuid,
           NULL,
           NULL,
           NULL,
           $5,
           '{}'::jsonb
         )`,
      ['delivery', JSON.stringify(ctx), 'shipment', randomUUID(), createIdempotencyKey]
    );

    expect(createdRows).toHaveLength(1);
    const created = createdRows[0];
    expect(created.task_id).toBeTruthy();
    expect(created.task_event_id).toBeTruthy();

    const { rows: createdRows2 } = await client.query(
      `SELECT *
         FROM public.create_task_v1(
           $1,
           $2::jsonb,
           $3,
           $4::uuid,
           NULL,
           NULL,
           NULL,
           $5,
           '{}'::jsonb
         )`,
      ['delivery', JSON.stringify(ctx), 'shipment', randomUUID(), createIdempotencyKey]
    );

    expect(createdRows2).toHaveLength(1);
    expect(createdRows2[0].task_id).toBe(created.task_id);
    expect(createdRows2[0].task_event_id).toBe(created.task_event_id);

    const assignIdempotencyKey = `idem-assign-${randomUUID()}`;
    const { rows: assignedRows } = await client.query(
      `SELECT *
         FROM public.assign_task_v1($1::uuid, $2::uuid, $3, $4)`,
      [created.task_id, assigneeId, assignIdempotencyKey, 'assign']
    );
    expect(assignedRows).toHaveLength(1);
    expect(assignedRows[0].task_id).toBe(created.task_id);
    expect(assignedRows[0].task_event_id).toBeTruthy();

    const { rows: assignedRows2 } = await client.query(
      `SELECT *
         FROM public.assign_task_v1($1::uuid, $2::uuid, $3, $4)`,
      [created.task_id, assigneeId, assignIdempotencyKey, 'assign']
    );
    expect(assignedRows2).toHaveLength(1);
    expect(assignedRows2[0].task_event_id).toBe(assignedRows[0].task_event_id);

    const transitionIdempotencyKey = `idem-transition-${randomUUID()}`;
    const { rows: transitionedRows } = await client.query(
      `SELECT *
         FROM public.transition_task_v1($1::uuid, $2, $3, $4::jsonb, $5)`,
      [created.task_id, 'completed', 'done', JSON.stringify({ source: 'integration' }), transitionIdempotencyKey]
    );
    expect(transitionedRows).toHaveLength(1);
    expect(transitionedRows[0].task_id).toBe(created.task_id);
    expect(transitionedRows[0].task_event_id).toBeTruthy();

    const { rows: transitionedRows2 } = await client.query(
      `SELECT *
         FROM public.transition_task_v1($1::uuid, $2, $3, $4::jsonb, $5)`,
      [created.task_id, 'completed', 'done', JSON.stringify({ source: 'integration' }), transitionIdempotencyKey]
    );
    expect(transitionedRows2).toHaveLength(1);
    expect(transitionedRows2[0].task_event_id).toBe(transitionedRows[0].task_event_id);

    const { rows: taskRows } = await client.query(
      `SELECT status, version, assigned_to
         FROM tasks
        WHERE id = $1::uuid`,
      [created.task_id]
    );
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0].status).toBe('completed');
    expect(taskRows[0].assigned_to).toBe(assigneeId);

    const { rows: latestEventRows } = await client.query(
      `SELECT to_status, task_version, decision_log_id
         FROM task_events
        WHERE task_id = $1::uuid
        ORDER BY task_version DESC
        LIMIT 1`,
      [created.task_id]
    );
    expect(latestEventRows).toHaveLength(1);
    expect(latestEventRows[0].to_status).toBe('completed');
    expect(Number(latestEventRows[0].task_version)).toBe(Number(taskRows[0].version));
    expect(latestEventRows[0].decision_log_id).toBeTruthy();

    const { rows: createEventRows } = await client.query(
      `SELECT settings_resolution_id
         FROM task_events
        WHERE id = $1::uuid`,
      [created.task_event_id]
    );
    expect(createEventRows).toHaveLength(1);
    expect(createEventRows[0].settings_resolution_id).toBeTruthy();
  });

  it('starts task-created workflows with worker entry point and task provenance', async () => {
    const { id: organizationId } = await createOrganization(client, 'Tasks Workflow Entry Point Org');
    const { id: clientId } = await createClient(client, organizationId, 'Tasks Workflow Entry Point Client');
    const senderId = await createSender(client, clientId, 'Tasks Workflow Entry Point Sender');
    const actorId = await createUser(
      client,
      organizationId,
      `task-workflow-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );

    const { rows: templateRows } = await client.query(
      `SELECT id
         FROM public.workflow_templates
        WHERE name = 'manual_review_v1'
          AND status = 'active'
        ORDER BY version DESC
        LIMIT 1`
    );
    const workflowTemplateId = templateRows[0]?.id;
    expect(workflowTemplateId).toBeTruthy();

    await client.query(
      `INSERT INTO public.task_types (
          organization_id,
          key,
          name,
          enabled,
          default_priority,
          default_queue_key,
          default_workflow_template_id
        )
        VALUES ($1::uuid, 'workflow_entry_point', 'Workflow Entry Point', true, 50, 'default', $2::uuid)`,
      [organizationId, workflowTemplateId]
    );

    await setAuthContext(client, actorId);

    const resourceId = randomUUID();
    const { rows: createdRows } = await client.query(
      `SELECT *
         FROM public.create_task_v1(
           $1,
           $2::jsonb,
           $3,
           $4::uuid,
           NULL,
           NULL,
           NULL,
           $5,
           '{}'::jsonb
         )`,
      [
        'workflow_entry_point',
        JSON.stringify({ organization_id: organizationId, client_id: clientId, sender_id: senderId }),
        'shipment',
        resourceId,
        `idem-workflow-entry-point-${randomUUID()}`
      ]
    );

    const created = createdRows[0];
    expect(created?.task_id).toBeTruthy();
    expect(created?.workflow_run_id).toBeTruthy();

    const { rows: runRows } = await client.query(
      `SELECT entry_point, context
         FROM public.workflow_runs
        WHERE id = $1::uuid
        LIMIT 1`,
      [created.workflow_run_id]
    );
    expect(runRows).toHaveLength(1);
    expect(runRows[0].entry_point).toBe('worker');
    expect(runRows[0].context?.trigger_type).toBe('task');
    expect(runRows[0].context?.task_id).toBe(created.task_id);
    expect(runRows[0].context?.task_type_key).toBe('workflow_entry_point');
    expect(runRows[0].context?.resource_type).toBe('shipment');
    expect(runRows[0].context?.resource_id).toBe(resourceId);
  });

  it('assign_task_system_v1 is service-only and idempotent', async () => {
    const { id: organizationId } = await createOrganization(client, 'Tasks System Assign Org');
    const { id: clientId } = await createClient(client, organizationId, 'Tasks System Assign Client');
    const senderId = await createSender(client, clientId, 'Tasks System Assign Sender');

    const actorId = await createUser(
      client,
      organizationId,
      `task-system-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );
    const assigneeId = await createUser(
      client,
      organizationId,
      `task-system-assignee-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );

    await client.query(
      `INSERT INTO task_types (organization_id, key, name, enabled, default_priority, default_queue_key)
       VALUES ($1::uuid, 'delivery', 'Delivery', true, 50, 'default')`,
      [organizationId]
    );

    await setAuthContext(client, actorId);

    const { rows: createdRows } = await client.query(
      `SELECT *
         FROM public.create_task_v1(
           $1,
           $2::jsonb,
           $3,
           $4::uuid,
           NULL,
           NULL,
           NULL,
           $5,
           '{}'::jsonb
         )`,
      [
        'delivery',
        JSON.stringify({ organization_id: organizationId, client_id: clientId, sender_id: senderId }),
        'shipment',
        randomUUID(),
        `idem-system-create-${randomUUID()}`
      ]
    );
    const taskId = createdRows[0]?.task_id;
    expect(taskId).toBeTruthy();

    const { rows: privilegeRows } = await client.query(
      `SELECT
          has_function_privilege('authenticated', 'public.assign_task_system_v1(uuid,uuid,text,text,text)', 'EXECUTE') AS authenticated_can_execute,
          has_function_privilege('service_role', 'public.assign_task_system_v1(uuid,uuid,text,text,text)', 'EXECUTE') AS service_role_can_execute`
    );
    expect(privilegeRows).toHaveLength(1);
    expect(privilegeRows[0].authenticated_can_execute).toBe(false);
    expect(privilegeRows[0].service_role_can_execute).toBe(true);

    await setServiceContext(actorId, organizationId);

    const idempotencyKey = `idem-system-assign-${randomUUID()}`;
    const { rows: assignedRows } = await client.query(
      `SELECT *
         FROM public.assign_task_system_v1($1::uuid, $2::uuid, $3, $4, $5)`,
      [taskId, assigneeId, idempotencyKey, 'system assign', 'dispatch_engine']
    );
    expect(assignedRows).toHaveLength(1);
    expect(assignedRows[0].task_id).toBe(taskId);
    expect(assignedRows[0].task_event_id).toBeTruthy();

    const { rows: assignedRows2 } = await client.query(
      `SELECT *
         FROM public.assign_task_system_v1($1::uuid, $2::uuid, $3, $4, $5)`,
      [taskId, assigneeId, idempotencyKey, 'system assign', 'dispatch_engine']
    );
    expect(assignedRows2).toHaveLength(1);
    expect(assignedRows2[0].task_event_id).toBe(assignedRows[0].task_event_id);

    const { rows: taskRows } = await client.query(
      `SELECT assigned_to
         FROM public.tasks
        WHERE id = $1::uuid`,
      [taskId]
    );
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0].assigned_to).toBe(assigneeId);

    const { rows: eventRows } = await client.query(
      `SELECT event_type, actor_system
         FROM public.task_events
        WHERE id = $1::uuid`,
      [assignedRows[0].task_event_id]
    );
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].event_type).toBe('assigned');
    expect(eventRows[0].actor_system).toBe('dispatch_engine');
  });
});
