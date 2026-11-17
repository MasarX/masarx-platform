const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { upsertSettings } = require('../../utils/policies');

const columnCache = {};
let fixtureAdminScopeSequence = 0;

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim() || null;
if (!DATABASE_URL) {
  // Avoid import-time hard failures so skip-gated suites can load safely.
  // Functions that require DB connectivity still fail closed when invoked.
  // eslint-disable-next-line no-console
  console.warn('[tests/integration/helpers/tenant-utils] DATABASE_URL not set at import time');
}

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;

function assertDatabaseUrl(label = 'tenant-utils') {
  if (!DATABASE_URL) {
    throw new Error(`[tests] DATABASE_URL is required for ${label}`);
  }
  return DATABASE_URL;
}

const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const randomSlug = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const WORKFLOW_TEMPLATE_ALIASES = Object.freeze({
  legacy_outbound_job_wrapper_v1: ['outbound_wrapper_v1'],
});

const INTEGRATION_TEST_ALLOWED_SCOPES = Object.freeze([
  'global',
  'tenant',
  'client',
  'sender',
  'source',
]);

async function grantSelectRecursive(client, tableName) {
  if (!IDENTIFIER_REGEX.test(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }

  await client.query(`GRANT SELECT ON ${tableName} TO authenticated`);

  const { rows } = await client.query(
    `SELECT inhrelid::regclass::text AS partition
       FROM pg_inherits
      WHERE inhparent = $1::regclass`,
    [tableName]
  );

  for (const { partition } of rows) {
    if (!IDENTIFIER_REGEX.test(partition)) {
      throw new Error(`Invalid partition name: ${partition}`);
    }
    await client.query(`GRANT SELECT ON ${partition} TO authenticated`);
  }
}

async function createOrganization(client, name, options = {}) {
  return withFixtureAdminContext(client, async (adminClient) => {
    const slug = options.slug || randomSlug('org');
    const { rows } = await adminClient.query(
      `INSERT INTO organizations (
        name,
        slug,
        timezone,
        locale,
        billing_status,
        default_settings
      )
      VALUES (
        $1,
        $2,
        COALESCE($3, 'Asia/Riyadh'),
        COALESCE($4, 'ar-SA'),
        COALESCE($5, 'active'),
        COALESCE($6::jsonb, '{}'::jsonb)
      )
      RETURNING id`,
      [
        name,
        slug,
        options.timezone,
        options.locale,
        options.billingStatus,
        options.defaultSettings ? JSON.stringify(options.defaultSettings) : null
      ]
    );
    return { id: rows[0].id, slug };
  });
}

async function createClient(client, organizationId, name, options = {}) {
  return withFixtureAdminContext(client, async (adminClient) => {
    const slug = options.slug || randomSlug('client');
    const { rows } = await adminClient.query(
      `INSERT INTO clients (
        organization_id,
        name,
        slug,
        sla_tier,
        status,
        settings_override
      )
      VALUES (
        $1::uuid,
        $2,
        $3,
        COALESCE($4, 'standard'),
        COALESCE($5, 'active'),
        COALESCE($6::jsonb, '{}'::jsonb)
      )
      RETURNING id`,
      [
        organizationId,
        name,
        slug,
        options.slaTier,
        options.status,
        options.settingsOverride ? JSON.stringify(options.settingsOverride) : null
      ]
    );
    return { id: rows[0].id, slug };
  });
}

async function createSender(client, clientId, name, options = {}) {
  return withFixtureAdminContext(client, async (adminClient) => {
    const { rows } = await adminClient.query(
      `INSERT INTO senders (
        client_id,
        name,
        brand_name,
        auto_provisioned,
        auto_recreate,
        status,
        settings_override
      )
      VALUES (
        $1::uuid,
        $2,
        $3,
        COALESCE($4, false),
        COALESCE($5, true),
        COALESCE($6, 'active'),
        COALESCE($7::jsonb, '{}'::jsonb)
      )
      RETURNING id`,
      [
        clientId,
        name,
        options.brandName || null,
        options.autoProvisioned,
        options.autoRecreate,
        options.status,
        options.settingsOverride ? JSON.stringify(options.settingsOverride) : null
      ]
    );
    return rows[0].id;
  });
}

async function createUser(client, organizationId, email, options = {}) {
  return withFixtureAdminContext(client, async (adminClient) => {
    const userId = options.id || randomUUID();
    const accessScopeType = options.accessScopeType || null;
    const accessScopeId = options.accessScopeId || null;
    const effectiveUserType = options.userType || 'ops_admin';
    const effectiveAccessScopeType = accessScopeType || 'tenant';
    await adminClient.query(
      `INSERT INTO users (
        id,
        organization_id,
        email,
        full_name,
        user_type,
        status,
        access_scope_type,
        access_scope_id
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3,
        $4,
        COALESCE($5, 'ops_admin'),
        COALESCE($6, 'active'),
        COALESCE($7, 'tenant'),
        $8::uuid
      )`,
      [
        userId,
        organizationId,
        email,
        options.fullName || `Test User ${email}`,
        options.userType,
        options.status,
        accessScopeType,
        accessScopeId
      ]
    );

    if (effectiveAccessScopeType === 'tenant' && options.provisionRbac !== false) {
      const templateKey = String(options.rbacTemplateKey || effectiveUserType || '').trim().toLowerCase();
      await provisionRbacTemplateAssignment(adminClient, organizationId, userId, templateKey, options.assignedByUserId || userId);
    }

    return userId;
  });
}

async function setFixtureUserPolicyCapabilities(client, orgId, userId, capabilities, options = {}) {
  return withFixtureAdminContext(client, async db => {
    const scopeType = options.scopeType || 'tenant';
    const scopeId = options.scopeId || orgId;
    const row = (await db.query(`SELECT p.policy,
      (SELECT version FROM public.schema_registry WHERE category='access_control_policy'
        AND is_active ORDER BY version DESC LIMIT 1) AS schema_version
      FROM public.resolve_access_control_policy_v1($1,$2::uuid,FALSE) p`, [scopeType, scopeId])).rows[0];
    if (!row?.policy || !Array.isArray(row.policy.roles) || !Number.isInteger(row.schema_version)) {
      throw new Error('Policy fixture requires resolved policy and active schema');
    }
    const roleKey = 'qa_policy_' + randomUUID().replace(/-/g, '');
    if (row.policy.roles.some(role => role.key === roleKey)) throw new Error('Policy role collision');
    const policy = { ...row.policy,
      roles: [...row.policy.roles, { key: roleKey, capability_keys: capabilities }],
      assignments: { ...row.policy.assignments,
        user_id: { ...row.policy.assignments?.user_id, [userId]: [roleKey] } },
    };
    await db.query(`SELECT public.upsert_settings_value_v1(
      'access_control_policy',$1,$2::uuid,$3::jsonb,$4::integer,$5::text)`,
      [scopeType, scopeId, JSON.stringify(policy), row.schema_version, 'Isolated fixture user policy authority']);
  });
}

async function provisionRbacTemplateAssignment(client, organizationId, userId, templateKey, assignedByUserId) {
  const key = String(templateKey || '').trim().toLowerCase();
  if (!key) return;

  const { rows } = await client.query(
    'SELECT template_key, role_id FROM public.provision_rbac_roles_from_templates_v1($1::uuid, $2::text[], $3::uuid)',
    [organizationId, [key], assignedByUserId || null]
  );

  let roleId = rows?.[0]?.role_id || null;
  let resolvedKey = key;
  if (!roleId && key !== 'ops_admin') {
    const fallback = await client.query(
      'SELECT template_key, role_id FROM public.provision_rbac_roles_from_templates_v1($1::uuid, $2::text[], $3::uuid)',
      [organizationId, ['ops_admin'], assignedByUserId || null]
    );
    roleId = fallback.rows?.[0]?.role_id || null;
    resolvedKey = 'ops_admin';
  }

  if (!roleId) return;

  await client.query(
    `INSERT INTO public.rbac_user_role_assignments (
        organization_id,
        user_id,
        role_id,
        assigned_by_user_id,
        metadata
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::jsonb
      )
      ON CONFLICT DO NOTHING`,
    [
      organizationId,
      userId,
      roleId,
      assignedByUserId || null,
      JSON.stringify({ seed: true, source: 'integration-helper', template_key: resolvedKey })
    ]
  );
}

async function setFixtureAdminContext(client) {
  await client.query('SET LOCAL ROLE NONE');
  await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claims', '']);
  await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', '']);
  await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.role', '']);
}

function isPoolQueryTarget(target) {
  return Boolean(
    target &&
    typeof target.query === 'function' &&
    typeof target.connect === 'function' &&
    typeof target.end === 'function' &&
    Number.isInteger(target.totalCount)
  );
}

async function restoreFixtureContext(client, snapshot) {
  await client.query('SET LOCAL ROLE NONE');
  await client.query('SELECT set_config($1, $2, true)', [
    'request.jwt.claims',
    snapshot.jwt_claims || '',
  ]);
  await client.query('SELECT set_config($1, $2, true)', [
    'request.jwt.claim.sub',
    snapshot.jwt_sub || '',
  ]);
  await client.query('SELECT set_config($1, $2, true)', [
    'request.jwt.claim.role',
    snapshot.jwt_role || '',
  ]);

  const currentRole = String(snapshot.current_role || '');
  const sessionRole = String(snapshot.session_role || '');
  if (currentRole && currentRole !== sessionRole) {
    if (!IDENTIFIER_REGEX.test(currentRole)) {
      throw new Error(`Invalid fixture role: ${currentRole}`);
    }
    await client.query(`SET LOCAL ROLE ${currentRole}`);
  }
}

async function snapshotFixtureContext(client) {
  let transactionStatus = null;
  const connection = client.connection;
  const captureReadyStatus = (message) => {
    transactionStatus = message?.status || null;
  };
  if (connection && typeof connection.once === 'function') {
    connection.once('readyForQuery', captureReadyStatus);
  }

  try {
    const { rows } = await client.query(
      `SELECT current_user::text AS current_role,
              session_user::text AS session_role,
              current_setting('request.jwt.claims', true) AS jwt_claims,
              current_setting('request.jwt.claim.sub', true) AS jwt_sub,
              current_setting('request.jwt.claim.role', true) AS jwt_role`
    );
    return {
      snapshot: rows[0] || {},
      transactionStatus: transactionStatus || client.fixtureTransactionStatus || null,
    };
  } finally {
    if (connection && typeof connection.removeListener === 'function') {
      connection.removeListener('readyForQuery', captureReadyStatus);
    }
  }
}

async function withFixtureAdminContext(queryTarget, operation) {
  if (typeof operation !== 'function') {
    throw new TypeError('withFixtureAdminContext requires an operation callback');
  }

  const ownsConnection = isPoolQueryTarget(queryTarget);
  const client = ownsConnection ? await queryTarget.connect() : queryTarget;
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('withFixtureAdminContext requires a query-capable client or pool');
  }

  let ownsTransaction = false;
  let savepoint = null;
  let operationError = null;

  try {
    const context = await snapshotFixtureContext(client);
    if (context.transactionStatus === 'E') {
      throw new Error('withFixtureAdminContext cannot enter an aborted transaction');
    }
    if (context.transactionStatus === 'T') {
      fixtureAdminScopeSequence += 1;
      savepoint = `fixture_admin_scope_${fixtureAdminScopeSequence}`;
      await client.query(`SAVEPOINT ${savepoint}`);
    } else {
      await client.query('BEGIN');
      ownsTransaction = true;
    }

    await setFixtureAdminContext(client);
    const result = await operation(client);
    await restoreFixtureContext(client, context.snapshot);
    if (savepoint) {
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    } else {
      await client.query('COMMIT');
    }
    return result;
  } catch (error) {
    operationError = error;
    if (savepoint) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (rollbackError) {
        operationError.fixtureAdminRollbackError = rollbackError;
      }
    } else if (ownsTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        operationError.fixtureAdminRollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    if (ownsConnection) {
      client.release(operationError || undefined);
    }
  }
}

async function setServiceContext(client, userId, organizationId, extraClaims = {}) {
  await client.query('SET LOCAL ROLE service_role');
  const claims = {
    sub: String(userId),
    role: 'service_role',
    organization_id: String(organizationId),
    ...extraClaims,
  };
  await client.query('SELECT set_config($1, $2, true)', [
    'request.jwt.claims',
    JSON.stringify(claims),
  ]);
  await client.query('SELECT set_config($1, $2, true)', [
    'request.jwt.claim.sub',
    String(userId),
  ]);
  await client.query('SELECT set_config($1, $2, true)', [
    'request.jwt.claim.role',
    'service_role',
  ]);
}

async function setAuthContext(client, userId, extraClaims = {}) {
  await client.query('SET LOCAL ROLE authenticated');
  const claims = {
    sub: userId,
    role: 'authenticated',
    ...extraClaims
  };
  const effectiveRole = String(claims.role || 'authenticated');
  await client.query('SELECT set_config($1, $2, true)', [
    'request.jwt.claims',
    JSON.stringify(claims)
  ]);
  // Align with auth.uid(), which reads request.jwt.claim.sub
  await client.query('SELECT set_config($1, $2, true)', [
    'request.jwt.claim.sub',
    String(userId)
  ]);
  await client.query('SELECT set_config($1, $2, true)', [
    'request.jwt.claim.role',
    effectiveRole
  ]);
}

async function createRequestContext(client, options = {}) {
  const id = options.id || randomUUID();
  const { rows } = await client.query(
    `INSERT INTO request_contexts (
        id,
        entry_point,
        client_id,
        user_id,
        primary_entity_type,
        primary_entity_id,
        batch_size,
        ip_address,
        user_agent,
        error_occurred
      )
      VALUES (
        $1::uuid,
        COALESCE($2, 'webhook'),
        $3::uuid,
        $4::uuid,
        $5,
        $6::uuid,
        $7,
        $8,
        $9,
        COALESCE($10, false)
      )
      RETURNING id`,
    [
      id,
      options.entryPoint,
      options.clientId || null,
      options.userId || null,
      options.primaryEntityType || null,
      options.primaryEntityId || null,
      options.batchSize || null,
      options.ipAddress || null,
      options.userAgent || null,
      options.errorOccurred
    ]
  );
  return rows[0].id;
}

async function createShipment(client, params) {
  return withFixtureAdminContext(client, async (adminClient) => {
    const {
      organizationId,
      clientId,
      serviceType = 'delivery',
      trackingNumber,
      status = 'pending',
      shipmentSettingsOverride,
      metadata
    } = params;

    const tracking =
      trackingNumber || `SHIP-${randomSlug('trk').replace(/[^a-z0-9]/gi, '').toUpperCase()}`;

    const { rows } = await adminClient.query(
      `INSERT INTO shipments (
        organization_id,
        client_id,
        service_type,
        tracking_number,
        status,
        shipment_settings_override,
        metadata
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3,
        $4,
        $5,
        COALESCE($6::jsonb, '{}'::jsonb),
        COALESCE($7::jsonb, '{}'::jsonb)
      )
      RETURNING id, tracking_number`,
      [
        organizationId,
        clientId,
        serviceType,
        tracking,
        status,
        shipmentSettingsOverride ? JSON.stringify(shipmentSettingsOverride) : null,
        metadata ? JSON.stringify(metadata) : null
      ]
    );
    return { id: rows[0].id, trackingNumber: rows[0].tracking_number };
  });
}

async function createLabel(client, params) {
  const {
    shipmentId,
    labelType = 'shipping',
    barcode,
    barcodeFormat = 'CODE128',
    fileUrl,
    fileSizeBytes = 4096
  } = params;

  const resolvedBarcode = barcode || `LBL-${randomSlug('code').replace(/[^a-z0-9]/gi, '').toUpperCase()}`;
  const resolvedFileUrl = fileUrl || `labels/${resolvedBarcode}.pdf`;

  if (!columnCache.labels) {
    const { rows } = await client.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'labels'`
    );
    columnCache.labels = new Set(rows.map((row) => row.column_name));
  }

  const labelColumns = columnCache.labels;

  const { rows: shipmentInfoRows } = await client.query(
    `SELECT organization_id, client_id, sender_id
       FROM shipments
      WHERE id = $1::uuid`,
    [shipmentId]
  );

  if (!shipmentInfoRows.length) {
    throw new Error(`Shipment ${shipmentId} not found when creating label`);
  }

  const shipmentInfo = shipmentInfoRows[0];

  const columns = ['shipment_id', 'label_type', 'barcode', 'barcode_format', 'file_url', 'file_size_bytes'];
  const values = [shipmentId, labelType, resolvedBarcode, barcodeFormat, resolvedFileUrl, fileSizeBytes];
  const placeholders = ['$1', '$2', '$3', '$4', '$5', '$6'];
  let paramIndex = 6;

  const pushColumn = (name, value) => {
    paramIndex += 1;
    columns.push(name);
    placeholders.push(`$${paramIndex}`);
    values.push(value);
  };

  if (labelColumns.has('organization_id')) {
    pushColumn('organization_id', shipmentInfo.organization_id);
  }

  if (labelColumns.has('client_id')) {
    pushColumn('client_id', shipmentInfo.client_id);
  }

  if (labelColumns.has('sender_id')) {
    pushColumn('sender_id', shipmentInfo.sender_id);
  }

  const insertSql = `INSERT INTO labels (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id, barcode`;
  const { rows } = await client.query(insertSql, values);
  if (!rows.length) {
    throw new Error(`Failed to insert label for shipment ${shipmentId}`);
  }
  return { id: rows[0].id, barcode: rows[0].barcode };
}

async function createMappingConfig(client, mappingType, mappingKey, config = {}, options = {}) {
  const { rows } = await client.query(
    `INSERT INTO mapping_configs (
        mapping_type,
        mapping_key,
        mapping_config,
        mapping_version,
        notes
      )
      VALUES (
        $1,
        $2,
        $3::jsonb,
        COALESCE($4, 1),
        $5
      )
      ON CONFLICT (mapping_type, mapping_key)
      DO UPDATE SET
        mapping_config = EXCLUDED.mapping_config,
        mapping_version = EXCLUDED.mapping_version,
        updated_at = now()
      RETURNING id`,
    [
      mappingType,
      mappingKey,
      JSON.stringify(config),
      options.mappingVersion,
      options.notes || null
    ]
  );
  return rows[0].id;
}

async function createWebhookSource(client, params) {
  const {
    organizationId,
    mappingConfigId,
    sourceIdentifier,
    name,
    providerType = 'generic',
    authToken,
    rateLimitPerHour = 1000,
    enabled = true
  } = params;

  const identifier = sourceIdentifier || randomSlug('source');
  const token = authToken || randomSlug('token');
  const { rows } = await client.query(
    `INSERT INTO webhook_sources (
        organization_id,
        source_identifier,
        name,
        provider_type,
        auth_token,
        mapping_config_id,
        rate_limit_per_hour,
        enabled
      )
      VALUES (
        $1::uuid,
        $2,
        $3,
        $4,
        $5,
        $6::uuid,
        $7,
        $8
      )
      RETURNING id, auth_token, source_identifier`,
    [
      organizationId,
      identifier,
      name || identifier,
      providerType,
      token,
      mappingConfigId,
      rateLimitPerHour,
      enabled
    ]
  );
  return {
    id: rows[0].id,
    authToken: rows[0].auth_token,
    sourceIdentifier: rows[0].source_identifier
  };
}

async function createWebhookInboxEntry(client, params) {
  const {
    id = randomUUID(),
    webhookSourceId,
    organizationId = null,
    providerType = 'generic',
    externalId = null,
    eventType = null,
    rawPayload = {},
    transformedPayload = null,
    headers = {},
    processingStatus = 'pending',
    correlationId,
    idempotencyKey = null,
    workflowRunId = null,
    policySettingsId = null,
    policyScopeType = null,
    policyScopeId = null,
    policyVersion = null
  } = params;

  await client.query(
    `
      SELECT insert_webhook_inbox_record(
        $1::uuid,
        $2::uuid,
        $3,
        $4::jsonb,
        $5::jsonb,
        $6,
        $7::uuid,
        $8
      )
    `,
    [
      id,
      webhookSourceId,
      providerType,
      JSON.stringify(rawPayload),
      JSON.stringify(headers),
      processingStatus,
      correlationId,
      idempotencyKey
    ]
  );

  await client.query(
    `
      UPDATE webhook_inbox
         SET external_id = COALESCE($2, external_id),
             event_type = COALESCE($3, event_type),
             transformed_payload = COALESCE($4::jsonb, transformed_payload),
             headers = COALESCE($5::jsonb, headers),
             processing_status = COALESCE($6, processing_status),
             organization_id = COALESCE($7::uuid, organization_id),
             workflow_run_id = COALESCE($8::uuid, workflow_run_id),
             policy_settings_id = COALESCE($9::uuid, policy_settings_id),
             policy_scope_type = COALESCE($10, policy_scope_type),
             policy_scope_id = COALESCE($11::uuid, policy_scope_id),
             policy_version = COALESCE($12, policy_version)
       WHERE id = $1::uuid
    `,
    [
      id,
      externalId,
      eventType,
      transformedPayload ? JSON.stringify(transformedPayload) : null,
      JSON.stringify(headers),
      processingStatus,
      organizationId,
      workflowRunId,
      policySettingsId,
      policyScopeType,
      policyScopeId,
      policyVersion
    ]
  );

  return id;
}

async function ensureSettingsCategoryContract(client, category) {
  const { rows } = await client.query(
    `
      SELECT category
        FROM settings_category_registry
       WHERE category = $1
       LIMIT 1
    `,
    [category]
  );

  if (rows.length) return;

  const permissiveSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: `Integration Test Contract (${category})`,
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: true,
  };

  await client.query(
    `
      INSERT INTO schema_registry (
          category,
          version,
          schema,
          description,
          examples,
          is_active
        )
        VALUES (
          $1,
          1,
          $2::jsonb,
          $3,
          $4::jsonb,
          true
        )
      ON CONFLICT (category, version)
      DO UPDATE
        SET schema = EXCLUDED.schema,
            description = EXCLUDED.description,
            examples = EXCLUDED.examples,
            is_active = true,
            deprecated_at = NULL,
            updated_at = now()
    `,
    [
      category,
      JSON.stringify(permissiveSchema),
      `Integration test category contract (${category}).`,
      JSON.stringify([{ integration_test: true, category }]),
    ]
  );

  await client.query(
    `
      INSERT INTO settings_category_registry (
          category,
          description,
          requires_schema,
          requires_global_default,
          side_effecting,
          safe_missing_behavior,
          allowed_scopes
        )
        VALUES (
          $1,
          $2,
          true,
          false,
          false,
          'return_null',
          $3::jsonb
        )
      ON CONFLICT (category) DO NOTHING
    `,
    [
      category,
      `Integration test category registry row (${category}).`,
      JSON.stringify(INTEGRATION_TEST_ALLOWED_SCOPES),
    ]
  );
}

async function applySetting(client, params) {
  return withFixtureAdminContext(client, async (adminClient) => {
    const {
      category,
      scopeType,
      scopeId = null,
      value,
      version = 1,
      schemaVersion = 1,
      approvedAt = null,
      changeReason = 'integration-test'
    } = params;

    await ensureSettingsCategoryContract(adminClient, category);
    await upsertSettings(
      category,
      scopeType,
      scopeId,
      value,
      changeReason,
      adminClient,
    );

    const scopeHash = scopeId ?? '00000000-0000-0000-0000-000000000000';
    const { rows } = await adminClient.query(
      `
        SELECT settings_version_id
        FROM settings
        WHERE category = $1
          AND scope_type = $2
          AND scope_hash = $3::uuid
        ORDER BY last_updated DESC
        LIMIT 1
      `,
      [category, scopeType, scopeHash],
    );

    const settingsVersionId = rows[0]?.settings_version_id || randomUUID();
    await adminClient.query(
      `
        UPDATE settings_versions
        SET version = $2,
            schema_version = $3,
            approved_at = COALESCE($4::timestamptz, approved_at),
            effective_from = COALESCE($4::timestamptz, effective_from)
        WHERE id = $1::uuid
      `,
      [settingsVersionId, version, schemaVersion, approvedAt || null],
    );

    return settingsVersionId;
  });
}

async function createWorkflowTemplate(client, params) {
  const {
    name,
    description,
    scopeType,
    scopeId = null,
    stepsChecksum = null,
    version = 1,
    status = 'active',
    operationName = 'workflow_control',
    transitionCondition = 'always',
    handlerKey = 'workflow_control',
    handlerVersion = 'v1',
    metadata = {}
  } = params;

  const baseName = name || randomSlug('workflow-template');
  const uniqueSuffix = `-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const templateName = `${baseName}${uniqueSuffix}`;
  const templateDescription = description || baseName;
  const metadataPayload = {
    ...metadata,
    base_name: baseName
  };

  const { rows } = await client.query(
    `INSERT INTO workflow_templates (
        name,
        description,
        version,
        status,
        scope_type,
        scope_id,
        steps_checksum
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6::uuid,
        $7
      )
      RETURNING id`,
    [templateName, templateDescription, version, status, scopeType, scopeId, stepsChecksum]
  );
  const templateId = rows[0].id;

  const { rows: stepRows } = await client.query(
    `INSERT INTO workflow_template_steps (
        workflow_template_id,
        sequence_order,
        operation_name,
        transition_condition,
        handler_key,
        handler_version,
        metadata,
        enabled
      )
      VALUES (
        $1::uuid,
        1,
        $2,
        $3,
        $4,
        $5,
        $6::jsonb,
        true
      )
      RETURNING id`,
    [
      templateId,
      operationName,
      transitionCondition,
      handlerKey,
      handlerVersion,
      JSON.stringify(metadataPayload)
    ]
  );

  return { templateId, stepId: stepRows[0].id };
}

async function setWorkflowEngineContext(client, params) {
  const { runId = null, stepId, local = true } = params;

  if (!stepId) {
    throw new Error('setWorkflowEngineContext requires stepId');
  }

  if (runId) {
    await client.query(`SELECT set_config('app.workflow_run_id', $1, $2)`, [runId, local]);
    await client.query(`SELECT set_config('app.workflow_run_step_id', $1, $2)`, [stepId, local]);
  }

  await client.query(`SELECT set_config('platform.workflow_engine', '1', $1)`, [local]);
  await client.query(`SELECT set_config('platform.workflow_run_step_id', $1, $2)`, [stepId, local]);
}

async function clearWorkflowEngineContext(client, params = {}) {
  const { local = false } = params;
  await client.query(`SELECT set_config('platform.workflow_engine', '', $1)`, [local]);
  await client.query(`SELECT set_config('platform.workflow_run_step_id', '', $1)`, [local]);
  await client.query(`SELECT set_config('app.workflow_run_id', '', $1)`, [local]);
  await client.query(`SELECT set_config('app.workflow_run_step_id', '', $1)`, [local]);
}

async function cleanupAutoOnboardingArtifacts(client, organizationId) {
  if (!organizationId) return;

  await client.query(
    `DELETE FROM public.integration_plugin_approval_events
      WHERE organization_id = $1::uuid`,
    [organizationId]
  );
  await client.query(
    `DELETE FROM public.integration_plugin_validation_runs
      WHERE organization_id = $1::uuid`,
    [organizationId]
  );
  await client.query(
    `DELETE FROM public.integration_plugin_bindings
      WHERE organization_id = $1::uuid`,
    [organizationId]
  );
  await client.query(
    `DELETE FROM public.webhook_sources
      WHERE organization_id = $1::uuid`,
    [organizationId]
  );
  await client.query(
    `DELETE FROM public.integration_plugin_versions
      WHERE organization_id = $1::uuid`,
    [organizationId]
  );
  await client.query(
    `DELETE FROM public.integration_plugins
      WHERE organization_id = $1::uuid`,
    [organizationId]
  );
  await client.query(
    `DELETE FROM public.tasks
      WHERE organization_id = $1::uuid`,
    [organizationId]
  );
  await client.query(
    `DELETE FROM public.mapping_configs
      WHERE organization_id = $1::uuid
        AND managed_by = 'integration_plugin'`,
    [organizationId]
  );
}

async function createWorkflowContext(client, params = {}) {
  const {
    templateName = null,
    templateId = null,
    scopeType = 'global',
    scopeId = null,
    context = {},
    local = true,
    operationName = 'workflow_control',
    handlerKey = 'workflow_control',
    handlerVersion = 'v1',
    metadata = {}
  } = params;

  let resolvedTemplateId = templateId;

  if (!resolvedTemplateId && templateName) {
    const candidateNames = [
      templateName,
      ...(WORKFLOW_TEMPLATE_ALIASES[templateName] || []),
    ];

    for (const candidateName of candidateNames) {
      const { rows } = await client.query(
        `
          SELECT id
          FROM workflow_templates
          WHERE name = $1
          ORDER BY updated_at DESC
          LIMIT 1
        `,
        [candidateName]
      );
      if (rows.length) {
        resolvedTemplateId = rows[0].id;
        break;
      }
    }

    if (!resolvedTemplateId) {
      throw new Error(
        `Workflow template not found: ${templateName} (aliases checked: ${candidateNames.join(', ')})`
      );
    }
  }

  if (!resolvedTemplateId) {
    const created = await createWorkflowTemplate(client, {
      scopeType,
      scopeId,
      operationName,
      handlerKey,
      handlerVersion,
      metadata
    });
    resolvedTemplateId = created.templateId;
  }

  const { rows: runRows } = await client.query(
    `SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id`,
    [resolvedTemplateId, JSON.stringify(context || {})]
  );
  const runId = runRows[0].run_id;

  const { rows: stepRows } = await client.query(
    `
      SELECT id
      FROM workflow_run_steps
      WHERE workflow_run_id = $1::uuid
      ORDER BY sequence_order
      LIMIT 1
    `,
    [runId]
  );

  if (!stepRows.length) {
    throw new Error(`Workflow run ${runId} missing steps`);
  }

  const stepId = stepRows[0].id;
  await setWorkflowEngineContext(client, { runId, stepId, local });

  return { runId, stepId, templateId: resolvedTemplateId };
}

async function cleanupWorkflowForLabelJobs(client, params = {}) {
  const { jobIds = [], workflowRunIds = [] } = params;
  const resolvedJobIds = jobIds.filter(Boolean);
  const resolvedRunIds = workflowRunIds.filter(Boolean);
  const stepIdSet = new Set();
  const jobIdSet = new Set(resolvedJobIds);

  if (resolvedJobIds.length) {
    const { rows: stepRows } = await client.query(
      `SELECT DISTINCT workflow_run_step_id
         FROM label_jobs
        WHERE id = ANY($1::uuid[])
          AND workflow_run_step_id IS NOT NULL`,
      [resolvedJobIds]
    );
    for (const row of stepRows) {
      stepIdSet.add(row.workflow_run_step_id);
    }
  }

  if (resolvedRunIds.length) {
    const { rows: runStepRows } = await client.query(
      `SELECT id
         FROM workflow_run_steps
        WHERE workflow_run_id = ANY($1::uuid[])`,
      [resolvedRunIds]
    );
    for (const row of runStepRows) {
      stepIdSet.add(row.id);
    }
  }

  const stepIds = Array.from(stepIdSet);
  const runIdSet = new Set(resolvedRunIds);
  let affectedLabelIds = [];

  if (stepIds.length) {
    const { rows: runRows } = await client.query(
      `SELECT DISTINCT workflow_run_id
         FROM workflow_run_steps
        WHERE id = ANY($1::uuid[])`,
      [stepIds]
    );
    for (const row of runRows) {
      runIdSet.add(row.workflow_run_id);
    }

    const { rows: derivedJobRows } = await client.query(
      `SELECT id
         FROM label_jobs
        WHERE workflow_run_step_id = ANY($1::uuid[])`,
      [stepIds]
    );
    for (const row of derivedJobRows) {
      jobIdSet.add(row.id);
    }
  }

  const affectedJobIds = Array.from(jobIdSet);
  let versionIds = [];

  if (affectedJobIds.length) {
    const { rows: jobRows } = await client.query(
      `SELECT DISTINCT label_id
         FROM label_jobs
        WHERE id = ANY($1::uuid[])
          AND label_id IS NOT NULL`,
      [affectedJobIds]
    );
    affectedLabelIds = jobRows.map((row) => row.label_id).filter(Boolean);

    if (affectedLabelIds.length) {
      await client.query(
        `DELETE FROM label_artifacts
          WHERE source_label_job_id = ANY($1::uuid[])
             OR id = ANY($2::uuid[])`,
        [affectedJobIds, affectedLabelIds]
      );
    } else {
      await client.query(
        `DELETE FROM label_artifacts
          WHERE source_label_job_id = ANY($1::uuid[])`,
        [affectedJobIds]
      );
    }

    const versionRows =
      affectedLabelIds.length > 0
        ? await client.query(
            `SELECT id
               FROM label_versions
              WHERE label_job_id = ANY($1::uuid[])
                 OR label_id = ANY($2::uuid[])`,
            [affectedJobIds, affectedLabelIds]
          )
        : await client.query(
            `SELECT id
               FROM label_versions
              WHERE label_job_id = ANY($1::uuid[])`,
            [affectedJobIds]
          );
    versionIds = versionRows.rows.map((row) => row.id).filter(Boolean);

    if (versionIds.length) {
      await client.query(
        `UPDATE labels
            SET active_version_id = NULL
          WHERE active_version_id = ANY($1::uuid[])`,
        [versionIds]
      );
      await client.query(
        `UPDATE label_jobs
            SET source_label_version_id = NULL
          WHERE source_label_version_id = ANY($1::uuid[])`,
        [versionIds]
      );
      await client.query(
        `UPDATE label_versions
            SET supersedes_version_id = NULL
          WHERE supersedes_version_id = ANY($1::uuid[])`,
        [versionIds]
      );
      await client.query(
        `UPDATE label_versions
            SET superseded_by_version_id = NULL,
                superseded_at = NULL,
                version_status = CASE
                  WHEN version_status = 'superseded' THEN 'active'
                  ELSE version_status
                END
          WHERE superseded_by_version_id = ANY($1::uuid[])`,
        [versionIds]
      );
    }

    await client.query(
      `UPDATE label_versions
          SET label_job_id = NULL
        WHERE label_job_id = ANY($1::uuid[])`,
      [affectedJobIds]
    );

    await client.query(
      `UPDATE label_jobs
          SET label_id = NULL,
              source_label_version_id = NULL
        WHERE id = ANY($1::uuid[])`,
      [affectedJobIds]
    );

    if (versionIds.length) {
      await client.query(`DELETE FROM label_versions WHERE id = ANY($1::uuid[])`, [versionIds]);
    }
  }

  if (stepIds.length) {
    await client.query(`DELETE FROM label_jobs WHERE workflow_run_step_id = ANY($1::uuid[])`, [stepIds]);
  }

  if (affectedJobIds.length) {
    await client.query(`DELETE FROM label_jobs WHERE id = ANY($1::uuid[])`, [affectedJobIds]);
  }

  if (affectedLabelIds.length) {
    await client.query(
      `DELETE FROM labels
        WHERE id = ANY($1::uuid[])
          AND active_version_id IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM label_versions
             WHERE label_versions.label_id = labels.id
          )
          AND NOT EXISTS (
            SELECT 1
               FROM label_jobs
             WHERE label_jobs.label_id = labels.id
               AND label_jobs.shipment_id = labels.shipment_id
          )`,
      [affectedLabelIds]
    );
  }

  if (stepIds.length) {
    await client.query(
      `DELETE FROM workflow_run_steps
        WHERE id = ANY($1::uuid[])
          AND NOT EXISTS (
            SELECT 1 FROM label_jobs WHERE workflow_run_step_id = workflow_run_steps.id
          )`,
      [stepIds]
    );
  }

  const runIds = Array.from(runIdSet);
  if (runIds.length) {
    await client.query(
      `DELETE FROM workflow_runs
        WHERE id = ANY($1::uuid[])
          AND NOT EXISTS (
            SELECT 1 FROM workflow_run_steps WHERE workflow_run_id = workflow_runs.id
          )`,
      [runIds]
    );
  }
}

async function fetchDecisionLog(client, filters = {}) {
  const {
    resourceType = null,
    resourceId = null,
    decisionCategory = null,
    limit = 50
  } = filters;

  await client.query('SAVEPOINT tenant_utils_fetch_decision_log');
  try {
    // Use a transaction-local service-role inspection path so authenticated
    // test callers do not gain persistent read access to sensitive logs.
    await client.query('SET LOCAL ROLE service_role');

    const result = await client.query(
      `
        SELECT id,
               decision_category,
               decision_outcome,
               decision_inputs,
               decision_reason,
               performed_by_system,
               timestamp
          FROM decision_log
         WHERE ($1::text IS NULL OR resource_type = $1::text)
           AND ($2::uuid IS NULL OR resource_id = $2::uuid)
           AND ($3::text IS NULL OR decision_category = $3::text)
         ORDER BY timestamp DESC, id DESC
         LIMIT GREATEST(1, COALESCE($4::int, 50))
      `,
      [resourceType, resourceId, decisionCategory, limit]
    );

    await client.query('ROLLBACK TO SAVEPOINT tenant_utils_fetch_decision_log');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT tenant_utils_fetch_decision_log').catch(() => {});
    throw error;
  }
}

async function progressWorkflowRunStep(client, runStepId, updates = {}) {
  const {
    stepStatus = 'completed',
    operationResult = null,
    decisionLogId = null,
    completedAt = null
  } = updates;

  await client.query(
    `
      UPDATE workflow_run_steps
      SET step_status = $2,
          operation_completed_at = COALESCE($3::timestamptz, operation_completed_at),
          operation_result = COALESCE($4::jsonb, operation_result),
          decision_log_id = COALESCE($5::uuid, decision_log_id),
          updated_at = now()
      WHERE id = $1::uuid
    `,
    [
      runStepId,
      stepStatus,
      completedAt ? completedAt : null,
      operationResult ? JSON.stringify(operationResult) : null,
      decisionLogId
    ]
  );
}

module.exports = {
  DATABASE_URL,
  pool,
  assertDatabaseUrl,
  randomSlug,
  grantSelectRecursive,
  createOrganization,
  createClient,
  createSender,
  createUser,
  setFixtureAdminContext,
  setFixtureUserPolicyCapabilities,
  withFixtureAdminContext,
  setServiceContext,
  setAuthContext,
  createRequestContext,
  createShipment,
  createLabel,
  createMappingConfig,
  createWebhookSource,
  createWebhookInboxEntry,
  applySetting,
  createWorkflowTemplate,
  createWorkflowContext,
  setWorkflowEngineContext,
  clearWorkflowEngineContext,
  cleanupAutoOnboardingArtifacts,
  cleanupWorkflowForLabelJobs,
  fetchDecisionLog,
  progressWorkflowRunStep,
  IDENTIFIER_REGEX
};
