const { Pool } = require('pg');
const {
  assertDatabaseUrl,
  grantSelectRecursive,
  createOrganization,
  createClient,
  createSender,
  createUser,
  setAuthContext,
  applySetting,
  createWorkflowTemplate
} = require('../helpers/tenant-utils');

const ORG_COUNT = 3;
const CLIENT_COUNT = 3;
const SENDER_COUNT = 3;
const WORKFLOW_COUNT = 4;
const MATRIX_E2E_TIMEOUT_MS = Math.max(
  150000,
  Number(process.env.MATRIX_E2E_TIMEOUT_MS || 240000),
);

jest.setTimeout(MATRIX_E2E_TIMEOUT_MS);

const TEST_RUN_PREFIX = `matrix-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

describe('Multi-tenant workflow matrix', () => {
  const pool = new Pool({ connectionString: assertDatabaseUrl('Multi-tenant workflow matrix') });
  let client;

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
    await grantSelectRecursive(client, 'organizations');
    await grantSelectRecursive(client, 'clients');
    await grantSelectRecursive(client, 'senders');
    await grantSelectRecursive(client, 'workflow_templates');
    await grantSelectRecursive(client, 'workflow_template_steps');
    await grantSelectRecursive(client, 'settings');
    await grantSelectRecursive(client, 'settings_versions');
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('provisions workflow matrix with scoped overrides and enforces RLS isolation', async () => {
    const matrix = [];

    for (let orgIndex = 0; orgIndex < ORG_COUNT; orgIndex += 1) {
      const { id: orgId } = await createOrganization(client, `Matrix Org ${orgIndex}`);
      const orgEntry = { id: orgId, index: orgIndex, clients: [] };
      matrix.push(orgEntry);

      await applySetting(client, {
        category: 'matrix_policy',
        scopeType: 'tenant',
        scopeId: orgId,
        value: { scope: 'tenant', org_index: orgIndex }
      });

      for (let clientIndex = 0; clientIndex < CLIENT_COUNT; clientIndex += 1) {
        const { id: clientId } = await createClient(
          client,
          orgId,
          `Matrix Org ${orgIndex} Client ${clientIndex}`
        );
        const clientEntry = { id: clientId, index: clientIndex, senders: [] };
        orgEntry.clients.push(clientEntry);

        await applySetting(client, {
          category: 'matrix_policy',
          scopeType: 'client',
          scopeId: clientId,
          value: { scope: 'client', org_index: orgIndex, client_index: clientIndex }
        });

        for (let senderIndex = 0; senderIndex < SENDER_COUNT; senderIndex += 1) {
          const senderId = await createSender(
            client,
            clientId,
            `Matrix Sender ${orgIndex}-${clientIndex}-${senderIndex}`
          );

          const senderEntry = {
            id: senderId,
            orgIndex,
            clientIndex,
            senderIndex
          };
          clientEntry.senders.push(senderEntry);

          await applySetting(client, {
            category: 'matrix_policy',
            scopeType: 'sender',
            scopeId: senderId,
            value: {
              scope: 'sender',
              org_index: orgIndex,
              client_index: clientIndex,
              sender_index: senderIndex
            }
          });

          for (let workflowIndex = 0; workflowIndex < WORKFLOW_COUNT; workflowIndex += 1) {
            const templateName = `${TEST_RUN_PREFIX}-${orgIndex}-${clientIndex}-${senderIndex}-wf-${workflowIndex}`;
            await createWorkflowTemplate(client, {
              name: templateName,
              description: `Matrix workflow ${templateName}`,
              scopeType: 'sender',
              scopeId: senderId,
              stepsChecksum: `checksum-${orgIndex}-${clientIndex}-${senderIndex}-${workflowIndex}`,
              metadata: {
                scenario: 'matrix',
                org_index: orgIndex,
                client_index: clientIndex,
                sender_index: senderIndex,
                workflow_index: workflowIndex
              }
            });
          }
        }
      }
    }

    const totalTemplates = WORKFLOW_COUNT * ORG_COUNT * CLIENT_COUNT * SENDER_COUNT;
    const totalSenderSettings = ORG_COUNT * CLIENT_COUNT * SENDER_COUNT;

    const [{ count: templateCount }] = (
      await client.query(
        `SELECT COUNT(*)::int AS count
           FROM workflow_templates
          WHERE scope_type = 'sender'
            AND name LIKE $1`,
        [`${TEST_RUN_PREFIX}%`]
      )
    ).rows;
    expect(templateCount).toBe(totalTemplates);

    const [{ count: senderSettings }] = (
      await client.query(
        `
        SELECT COUNT(*)::int AS count
        FROM settings
        WHERE category = 'matrix_policy'
          AND scope_type = 'sender'
        `
      )
    ).rows;
    expect(senderSettings).toBe(totalSenderSettings);

    const userOrg0 = await createUser(client, matrix[0].id, 'matrix-org0@example.com');
    const userOrg1 = await createUser(client, matrix[1].id, 'matrix-org1@example.com');

    const senderIdsOrg0 = matrix[0].clients.flatMap((entry) =>
      entry.senders.map((sender) => sender.id)
    );

    const { rows: preAuthSettings } = await client.query(
      `
        SELECT scope_id
          FROM settings
         WHERE category = 'matrix_policy'
           AND scope_type = 'sender'
           AND scope_id = ANY($1::uuid[])
      `,
      [senderIdsOrg0]
    );
    expect(preAuthSettings).toHaveLength(senderIdsOrg0.length);

    await setAuthContext(client, userOrg0);

    const [{ count: accessibleTemplateCount }] = (
      await client.query(
        `
          SELECT COUNT(*)::int AS count
          FROM workflow_templates
          WHERE scope_type = 'sender'
            AND scope_id = ANY($1::uuid[])
            AND name LIKE $2
        `,
        [senderIdsOrg0, `${TEST_RUN_PREFIX}%`]
      )
    ).rows;
    expect(accessibleTemplateCount).toBe(WORKFLOW_COUNT * senderIdsOrg0.length);

    const senderSettingsRows = (
      await client.query(
        `
          SELECT (cached_value->>'sender_index')::int AS sender_index,
                 cached_value->>'scope' AS scope_label
          FROM settings
          WHERE category = 'matrix_policy'
            AND scope_type = 'sender'
            AND scope_id = ANY($1::uuid[])
          ORDER BY sender_index
        `,
        [senderIdsOrg0]
      )
    ).rows;
    expect(senderSettingsRows).toHaveLength(0);

    const senderIdsOrg1 = matrix[1].clients.flatMap((entry) =>
      entry.senders.map((sender) => sender.id)
    );
    const crossOrgTemplates = (
      await client.query(
        `
          SELECT id
          FROM workflow_templates
          WHERE scope_id = ANY($1::uuid[])
        `,
        [senderIdsOrg1]
      )
    ).rows;
    expect(crossOrgTemplates).toHaveLength(0);

    await client.query('RESET ROLE');
    await setAuthContext(client, userOrg1);
    const clientIdsOrg0 = matrix[0].clients.map((entry) => entry.id);
    const blockedSenders = (
      await client.query(
        `
          SELECT id
          FROM senders
          WHERE client_id = ANY($1::uuid[])
        `,
        [clientIdsOrg0]
      )
    ).rows;
    expect(blockedSenders).toHaveLength(0);

    await client.query('RESET ROLE');
    const { rows: serviceRoleSettings } = await client.query(
      `
        SELECT (cached_value->>'sender_index')::int AS sender_index,
               cached_value->>'scope' AS scope_label
        FROM settings
        WHERE category = 'matrix_policy'
          AND scope_type = 'sender'
          AND scope_id = ANY($1::uuid[])
        ORDER BY sender_index
      `,
      [senderIdsOrg0]
    );
    expect(serviceRoleSettings).toHaveLength(senderIdsOrg0.length);
    serviceRoleSettings.forEach((row) => {
      expect(row.scope_label).toBe('sender');
      expect(row.sender_index).toBeGreaterThanOrEqual(0);
      expect(row.sender_index).toBeLessThan(SENDER_COUNT);
    });

    const [{ unique_checksums: uniqueChecksums }] = (
      await client.query(
        `
          SELECT COUNT(*)::int AS unique_checksums
          FROM (
            SELECT DISTINCT steps_checksum
            FROM workflow_templates
            WHERE scope_type = 'sender'
              AND name LIKE $1
          ) AS checksums
        `,
        [`${TEST_RUN_PREFIX}%`]
      )
    ).rows;
    expect(uniqueChecksums).toBe(totalTemplates);
  });
});
