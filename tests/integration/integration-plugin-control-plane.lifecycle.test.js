const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const { loadEnv } = require('../../scripts/utils/load-env');
const {
  createOrganization,
  createUser,
  createWorkflowTemplate,
  setAuthContext,
} = require('./helpers/tenant-utils');

loadEnv();

jest.setTimeout(120_000);

const DATABASE_URL = String(
  process.env.DATABASE_URL || process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL_POOLER || '',
).trim();
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 4 }) : null;

describeIfDb('integration plugin control-plane lifecycle', () => {
  let client;

  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    if (client) {
      client.release();
    }
    await pool.end();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  async function setTenantAuthContext(organizationId, userId) {
    await setAuthContext(client, userId, {
      organization_id: organizationId,
      access_scope_type: 'tenant',
      access_scope_id: null,
    });
  }

  async function setServiceContext(organizationId, userId) {
    await client.query('SET LOCAL ROLE service_role');
    const claims = {
      role: 'service_role',
      sub: userId,
      organization_id: organizationId,
      access_scope_type: 'tenant',
      access_scope_id: null,
    };
    await client.query(`SELECT set_config($1, $2, true)`, [
      'request.jwt.claims',
      JSON.stringify(claims),
    ]);
    await client.query(`SELECT set_config($1, $2, true)`, [
      'request.jwt.claim.sub',
      String(userId),
    ]);
  }

  async function createActiveTemplateName(organizationId, baseName) {
    const { templateId } = await createWorkflowTemplate(client, {
      name: baseName,
      description: `${baseName} lifecycle test template`,
      scopeType: 'tenant',
      scopeId: organizationId,
      operationName: 'workflow_control',
      handlerKey: 'workflow_control',
      handlerVersion: 'v1',
    });

    const { rows } = await client.query(
      `
        SELECT name
        FROM public.workflow_templates
        WHERE id = $1::uuid
      `,
      [templateId],
    );

    return rows[0]?.name ?? null;
  }

  async function generateDraft({
    pluginName,
    workflowTemplateName,
    routePath,
    pluginId = null,
    pluginKey = null,
    metadata = {},
  }) {
    const { rows } = await client.query(
      `
        SELECT api.integration_plugin_generate_draft_v1(
          p_plugin_name := $1::text,
          p_plugin_kind := 'api',
          p_source_type := 'manual',
          p_source_payload := $2::jsonb,
          p_inbound_config := $3::jsonb,
          p_mapping_config := $4::jsonb,
          p_workflow_binding := $5::jsonb,
          p_outbound_operations := '[]'::jsonb,
          p_plugin_id := $6::uuid,
          p_plugin_key := $7::text,
          p_description := $8::text,
          p_organization_id := $9::uuid,
          p_metadata := $10::jsonb
        ) AS result
      `,
      [
        pluginName,
        JSON.stringify({ generated_by: 'integration_test', route_path: routePath }),
        JSON.stringify({
          route: {
            method: 'POST',
            path_template: routePath,
            upstream_method: 'POST',
            upstream_path_template: routePath,
            policy: {
              workflow: {
                enabled: true,
                template_name: workflowTemplateName,
              },
              delivery: {
                mode: 'accepted_async',
                status_code: 202,
              },
            },
          },
        }),
        JSON.stringify({
          fields: [
            { target_field: 'external_id', source_path: '$.external_id' },
            { target_field: 'status', source_path: '$.status' },
          ],
        }),
        JSON.stringify({
          template_name: workflowTemplateName,
        }),
        pluginId,
        pluginKey,
        `${pluginName} control-plane lifecycle test`,
        null,
        JSON.stringify({ stage: 'integration-test', ...metadata }),
      ],
    );

    return rows[0]?.result ?? null;
  }

  async function validateDraft(pluginVersionId) {
    const { rows } = await client.query(
      `
        SELECT api.integration_plugin_validate_v1(
          p_plugin_version_id := $1::uuid,
          p_preview_payload := '{}'::jsonb,
          p_allow_external_side_effects := FALSE
        ) AS result
      `,
      [pluginVersionId],
    );

    return rows[0]?.result ?? null;
  }

  async function submitDraft(pluginVersionId, reason) {
    const { rows } = await client.query(
      `
        SELECT api.integration_plugin_submit_v1(
          p_plugin_version_id := $1::uuid,
          p_reason := $2::text
        ) AS result
      `,
      [pluginVersionId, reason],
    );

    return rows[0]?.result ?? null;
  }

  async function approveDraft(pluginVersionId, decision, reason) {
    const { rows } = await client.query(
      `
        SELECT api.integration_plugin_approve_v1(
          p_plugin_version_id := $1::uuid,
          p_decision := $2::text,
          p_reason := $3::text
        ) AS result
      `,
      [pluginVersionId, decision, reason],
    );

    return rows[0]?.result ?? null;
  }

  async function activateVersion(pluginVersionId, scopeId, reason) {
    const { rows } = await client.query(
      `
        SELECT api.integration_plugin_activate_v1(
          p_plugin_version_id := $1::uuid,
          p_scope_type := 'tenant',
          p_scope_id := $2::uuid,
          p_reason := $3::text
        ) AS result
      `,
      [pluginVersionId, scopeId, reason],
    );

    return rows[0]?.result ?? null;
  }

  async function exportHandoff(pluginVersionId, baseUrl) {
    const { rows } = await client.query(
      `
        SELECT api.integration_plugin_export_handoff_v1(
          p_plugin_version_id := $1::uuid,
          p_base_url := $2::text
        ) AS result
      `,
      [pluginVersionId, baseUrl],
    );

    return rows[0]?.result ?? null;
  }

  async function rotateCredentials(pluginVersionId, authType, credentials, expiresAt, reason) {
    const { rows } = await client.query(
      `
        SELECT api.integration_plugin_rotate_credentials_v1(
          p_plugin_version_id := $1::uuid,
          p_auth_type := $2::text,
          p_credentials := $3::jsonb,
          p_expires_at := $4::timestamptz,
          p_reason := $5::text
        ) AS result
      `,
      [pluginVersionId, authType, JSON.stringify(credentials ?? {}), expiresAt, reason],
    );

    return rows[0]?.result ?? null;
  }

  async function rollbackPlugin(pluginId, targetPluginVersionId, reason) {
    const { rows } = await client.query(
      `
        SELECT api.integration_plugin_rollback_v1(
          p_plugin_id := $1::uuid,
          p_target_plugin_version_id := $2::uuid,
          p_reason := $3::text
        ) AS result
      `,
      [pluginId, targetPluginVersionId, reason],
    );

    return rows[0]?.result ?? null;
  }

  async function readPlugin(pluginId) {
    const { rows } = await client.query(
      `
        SELECT id, plugin_key, name, plugin_kind, status, active_version_id
        FROM public.integration_plugins
        WHERE id = $1::uuid
      `,
      [pluginId],
    );

    return rows[0] ?? null;
  }

  async function readVersion(pluginVersionId) {
    const { rows } = await client.query(
      `
        SELECT
          id,
          plugin_id,
          version_no,
          status,
          submitted_at,
          approved_at,
          activated_at,
          submitted_by,
          approved_by,
          activated_by,
          diff_hash,
          artifact_hash,
          validation_summary,
          auth_bindings
        FROM public.integration_plugin_versions
        WHERE id = $1::uuid
      `,
      [pluginVersionId],
    );

    return rows[0] ?? null;
  }

  async function readBindings(pluginVersionId) {
    const { rows } = await client.query(
      `
        SELECT
          b.binding_type,
          b.runtime_resource_type,
          b.runtime_resource_id,
          b.scope_type,
          b.scope_id,
          b.enabled AS binding_enabled,
          CASE
            WHEN b.runtime_resource_type = 'webhook_sources' THEN (
              SELECT ws.enabled
              FROM public.webhook_sources ws
              WHERE ws.id = b.runtime_resource_id
            )
            WHEN b.runtime_resource_type = 'api_routes' THEN (
              SELECT r.enabled
              FROM public.api_routes r
              WHERE r.id = b.runtime_resource_id
            )
            WHEN b.runtime_resource_type = 'providers' THEN (
              SELECT p.enabled
              FROM public.providers p
              WHERE p.id = b.runtime_resource_id
            )
            ELSE NULL
          END AS runtime_enabled
        FROM public.integration_plugin_bindings b
        WHERE b.plugin_version_id = $1::uuid
        ORDER BY b.binding_type ASC, b.created_at ASC
      `,
      [pluginVersionId],
    );

    return rows;
  }

  async function readApprovalEvents(pluginId) {
    const { rows } = await client.query(
      `
        SELECT e.action, e.reason, e.plugin_version_id, e.payload
        FROM public.integration_plugin_approval_events e
        JOIN public.integration_plugin_versions v
          ON v.id = e.plugin_version_id
        WHERE v.plugin_id = $1::uuid
        ORDER BY e.created_at ASC, e.id ASC
      `,
      [pluginId],
    );

    return rows;
  }

  async function readProviderAuthConfig(authConfigId) {
    const { rows } = await client.query(
      `
        SELECT id, provider_id, auth_type, expires_at
        FROM public.provider_auth_configs
        WHERE id = $1::uuid
      `,
      [authConfigId],
    );

    return rows[0] ?? null;
  }

  async function createActivatedPluginVersion({
    organizationId,
    builderUserId,
    approverUserId,
    workflowTemplateName,
    pluginName,
    routePath,
    pluginId = null,
    pluginKey = null,
    metadata = {},
    submitReason,
    approveReason,
    activateReason,
  }) {
    await setTenantAuthContext(organizationId, builderUserId);

    const draft = await generateDraft({
      pluginName,
      workflowTemplateName,
      routePath,
      pluginId,
      pluginKey,
      metadata,
    });
    const validation = await validateDraft(draft.version_id);
    const submission = await submitDraft(
      draft.version_id,
      submitReason ?? `Submit ${pluginName} for approval`,
    );

    await setTenantAuthContext(organizationId, approverUserId);

    const approval = await approveDraft(
      draft.version_id,
      'approved',
      approveReason ?? `Approve ${pluginName}`,
    );
    const activation = await activateVersion(
      draft.version_id,
      organizationId,
      activateReason ?? `Activate ${pluginName}`,
    );

    return {
      draft,
      validation,
      submission,
      approval,
      activation,
    };
  }

  test('api wrappers drive draft validate submit approve and activate with runtime bindings', async () => {
    const organization = await createOrganization(client, 'Integration Plugin Lifecycle Org');
    const builderUserId = await createUser(
      client,
      organization.id,
      `integration-plugin-builder-${randomUUID().slice(0, 8)}@example.com`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );
    const approverUserId = await createUser(
      client,
      organization.id,
      `integration-plugin-approver-${randomUUID().slice(0, 8)}@example.com`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );

    const workflowTemplateName = await createActiveTemplateName(
      organization.id,
      `integration-plugin-route-template-${Date.now()}`,
    );
    expect(workflowTemplateName).toBeTruthy();

    const firstVersion = await createActivatedPluginVersion({
      organizationId: organization.id,
      builderUserId,
      approverUserId,
      workflowTemplateName,
      pluginName: 'Lifecycle API Plugin',
      routePath: '/plugins/lifecycle/v1',
      pluginKey: `lifecycle-api-${Date.now()}`,
      metadata: { release_marker: 'v1' },
      submitReason: 'Submit initial lifecycle plugin version for approval',
      approveReason: 'Approve initial lifecycle plugin version',
      activateReason: 'Activate initial lifecycle plugin version',
    });
    const {
      draft: firstDraft,
      validation: firstValidation,
      submission: firstSubmit,
      approval: firstApproval,
      activation: firstActivation,
    } = firstVersion;

    expect(firstDraft?.ok).toBe(true);
    expect(firstDraft?.plugin_id).toBeTruthy();
    expect(firstDraft?.version_id).toBeTruthy();
    expect(firstDraft?.version_no).toBe(1);

    expect(firstValidation).toMatchObject({
      ok: true,
      plugin_id: firstDraft.plugin_id,
      plugin_version_id: firstDraft.version_id,
    });
    expect(Array.isArray(firstValidation.errors)).toBe(true);
    expect(firstValidation.errors).toHaveLength(0);

    expect(firstSubmit).toMatchObject({
      ok: true,
      plugin_id: firstDraft.plugin_id,
      plugin_version_id: firstDraft.version_id,
      status: 'submitted',
    });

    expect(firstApproval).toMatchObject({
      ok: true,
      plugin_id: firstDraft.plugin_id,
      plugin_version_id: firstDraft.version_id,
      status: 'approved',
    });
    expect(firstApproval.diff_hash).toBeTruthy();
    expect(firstApproval.artifact_hash).toBeTruthy();

    expect(firstActivation).toMatchObject({
      ok: true,
      plugin_id: firstDraft.plugin_id,
      plugin_version_id: firstDraft.version_id,
      status: 'active',
      scope_type: 'tenant',
      scope_id: organization.id,
      reactivated_existing_bindings: false,
    });
    expect(firstActivation.webhook_source_id).toBeTruthy();
    expect(firstActivation.api_route_id).toBeTruthy();
    expect(firstActivation.api_route_pack_id).toBeTruthy();
    expect(firstActivation.provider_id).toBeTruthy();
    expect(firstActivation.issued_token).toMatch(/^ipt_/);
    expect(firstActivation.artifact_hash).toBeTruthy();

    const firstHandoff = await exportHandoff(firstDraft.version_id, 'https://api.example.test/');
    expect(firstHandoff).toMatchObject({
      ok: true,
      plugin_id: firstDraft.plugin_id,
      plugin_version_id: firstDraft.version_id,
      kind: 'api',
      method: 'POST',
      token: firstActivation.issued_token,
    });
    expect(firstHandoff.endpoint).toContain('/functions/v1/api-gateway/t/');
    expect(firstHandoff.endpoint).toContain('/plugins/lifecycle/v1');

    await setServiceContext(organization.id, approverUserId);

    const pluginAfterFirstActivation = await readPlugin(firstDraft.plugin_id);
    expect(pluginAfterFirstActivation).toMatchObject({
      id: firstDraft.plugin_id,
      plugin_kind: 'api',
      status: 'active',
      active_version_id: firstDraft.version_id,
    });

    const versionOneAfterActivation = await readVersion(firstDraft.version_id);
    expect(versionOneAfterActivation).toMatchObject({
      id: firstDraft.version_id,
      plugin_id: firstDraft.plugin_id,
      version_no: 1,
      status: 'active',
      submitted_by: builderUserId,
      approved_by: approverUserId,
      activated_by: approverUserId,
    });
    expect(versionOneAfterActivation.validation_summary?.ok).toBe(true);
    expect(versionOneAfterActivation.validation_summary?.validation_run_id).toBeTruthy();

    const versionOneBindingsAfterActivation = await readBindings(firstDraft.version_id);
    expect(versionOneBindingsAfterActivation).toHaveLength(3);
    expect(versionOneBindingsAfterActivation.map((row) => row.binding_type)).toEqual([
      'api_route',
      'provider',
      'webhook_source',
    ]);
    for (const binding of versionOneBindingsAfterActivation) {
      expect(binding.scope_type).toBe('tenant');
      expect(binding.scope_id).toBe(organization.id);
      expect(binding.binding_enabled).toBe(true);
      expect(binding.runtime_enabled).toBe(true);
    }

    const approvalEvents = await readApprovalEvents(firstDraft.plugin_id);
    expect(approvalEvents).toHaveLength(3);
    expect(approvalEvents.every((row) => row.plugin_version_id === firstDraft.version_id)).toBe(true);
    expect(approvalEvents.map((row) => row.action).sort()).toEqual([
      'activated',
      'approved',
      'submitted',
    ]);
  });

  test('activating v2 disables v1 runtime assets and rollback reactivates v1 without rematerializing bindings', async () => {
    const organization = await createOrganization(client, 'Integration Plugin Rollback Org');
    const builderUserId = await createUser(
      client,
      organization.id,
      `integration-plugin-rollback-builder-${randomUUID().slice(0, 8)}@example.com`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );
    const approverUserId = await createUser(
      client,
      organization.id,
      `integration-plugin-rollback-approver-${randomUUID().slice(0, 8)}@example.com`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );
    const workflowTemplateName = await createActiveTemplateName(
      organization.id,
      `integration-plugin-rollback-template-${Date.now()}`,
    );
    const pluginKey = `lifecycle-rollback-${Date.now()}`;

    const firstVersion = await createActivatedPluginVersion({
      organizationId: organization.id,
      builderUserId,
      approverUserId,
      workflowTemplateName,
      pluginName: 'Lifecycle Rollback Plugin',
      routePath: '/plugins/lifecycle/rollback/v1',
      pluginKey,
      metadata: { release_marker: 'v1' },
      submitReason: 'Submit rollback test plugin v1',
      approveReason: 'Approve rollback test plugin v1',
      activateReason: 'Activate rollback test plugin v1',
    });
    const firstDraft = firstVersion.draft;
    const firstActivation = firstVersion.activation;

    const secondVersion = await createActivatedPluginVersion({
      organizationId: organization.id,
      builderUserId,
      approverUserId,
      workflowTemplateName,
      pluginName: 'Lifecycle Rollback Plugin',
      routePath: '/plugins/lifecycle/rollback/v2',
      pluginId: firstDraft.plugin_id,
      pluginKey,
      metadata: { release_marker: 'v2' },
      submitReason: 'Submit rollback test plugin v2',
      approveReason: 'Approve rollback test plugin v2',
      activateReason: 'Activate rollback test plugin v2',
    });
    const secondDraft = secondVersion.draft;
    const secondActivation = secondVersion.activation;

    expect(secondDraft?.ok).toBe(true);
    expect(secondDraft?.plugin_id).toBe(firstDraft.plugin_id);
    expect(secondDraft?.version_no).toBe(2);
    expect(secondActivation).toMatchObject({
      ok: true,
      plugin_id: firstDraft.plugin_id,
      plugin_version_id: secondDraft.version_id,
      status: 'active',
      scope_type: 'tenant',
      scope_id: organization.id,
      reactivated_existing_bindings: false,
    });
    expect(secondActivation.issued_token).toMatch(/^ipt_/);

    await setServiceContext(organization.id, approverUserId);

    const pluginAfterSecondActivation = await readPlugin(firstDraft.plugin_id);
    expect(pluginAfterSecondActivation).toMatchObject({
      id: firstDraft.plugin_id,
      status: 'active',
      active_version_id: secondDraft.version_id,
    });

    const versionOneAfterSecondActivation = await readVersion(firstDraft.version_id);
    const versionTwoAfterSecondActivation = await readVersion(secondDraft.version_id);
    expect(versionOneAfterSecondActivation).toMatchObject({
      id: firstDraft.version_id,
      plugin_id: firstDraft.plugin_id,
      version_no: 1,
      status: 'approved',
    });
    expect(versionTwoAfterSecondActivation).toMatchObject({
      id: secondDraft.version_id,
      plugin_id: firstDraft.plugin_id,
      version_no: 2,
      status: 'active',
    });

    const versionOneBindingsDisabled = await readBindings(firstDraft.version_id);
    const versionTwoBindingsEnabled = await readBindings(secondDraft.version_id);
    expect(versionOneBindingsDisabled).toHaveLength(3);
    expect(versionTwoBindingsEnabled).toHaveLength(3);
    expect(versionOneBindingsDisabled.every((row) => row.binding_enabled === false)).toBe(true);
    expect(versionOneBindingsDisabled.every((row) => row.runtime_enabled === false)).toBe(true);
    expect(versionTwoBindingsEnabled.every((row) => row.binding_enabled === true)).toBe(true);
    expect(versionTwoBindingsEnabled.every((row) => row.runtime_enabled === true)).toBe(true);

    await setTenantAuthContext(organization.id, approverUserId);

    const rollback = await rollbackPlugin(
      firstDraft.plugin_id,
      firstDraft.version_id,
      'Rollback plugin lifecycle to v1',
    );
    expect(rollback).toMatchObject({
      ok: true,
      plugin_id: firstDraft.plugin_id,
      from_plugin_version_id: secondDraft.version_id,
      to_plugin_version_id: firstDraft.version_id,
      scope_type: 'tenant',
      scope_id: organization.id,
    });
    expect(rollback.activation).toMatchObject({
      ok: true,
      plugin_id: firstDraft.plugin_id,
      plugin_version_id: firstDraft.version_id,
      status: 'active',
      scope_type: 'tenant',
      scope_id: organization.id,
      reactivated_existing_bindings: true,
      webhook_source_id: firstActivation.webhook_source_id,
      api_route_id: firstActivation.api_route_id,
      api_route_pack_id: firstActivation.api_route_pack_id,
      provider_id: firstActivation.provider_id,
    });
    expect(rollback.activation.issued_token).toBeNull();

    await setServiceContext(organization.id, approverUserId);

    const pluginAfterRollback = await readPlugin(firstDraft.plugin_id);
    expect(pluginAfterRollback).toMatchObject({
      id: firstDraft.plugin_id,
      status: 'active',
      active_version_id: firstDraft.version_id,
    });

    const versionOneAfterRollback = await readVersion(firstDraft.version_id);
    const versionTwoAfterRollback = await readVersion(secondDraft.version_id);
    expect(versionOneAfterRollback).toMatchObject({
      id: firstDraft.version_id,
      plugin_id: firstDraft.plugin_id,
      version_no: 1,
      status: 'active',
    });
    expect(versionTwoAfterRollback).toMatchObject({
      id: secondDraft.version_id,
      plugin_id: firstDraft.plugin_id,
      version_no: 2,
      status: 'approved',
    });

    const versionOneBindingsReactivated = await readBindings(firstDraft.version_id);
    const versionTwoBindingsDisabled = await readBindings(secondDraft.version_id);
    expect(versionOneBindingsReactivated).toHaveLength(3);
    expect(versionTwoBindingsDisabled).toHaveLength(3);
    expect(versionOneBindingsReactivated.every((row) => row.binding_enabled === true)).toBe(true);
    expect(versionOneBindingsReactivated.every((row) => row.runtime_enabled === true)).toBe(true);
    expect(versionTwoBindingsDisabled.every((row) => row.binding_enabled === false)).toBe(true);
    expect(versionTwoBindingsDisabled.every((row) => row.runtime_enabled === false)).toBe(true);

    const approvalEvents = await readApprovalEvents(firstDraft.plugin_id);
    expect(approvalEvents).toHaveLength(8);
    expect(approvalEvents.map((row) => row.action).sort()).toEqual([
      'activated',
      'activated',
      'approved',
      'approved',
      'rolled_back',
      'submitted',
      'submitted',
      'activated',
    ].sort());

    const rollbackActivationEvent = approvalEvents.find(
      (row) =>
        row.action === 'activated'
        && row.plugin_version_id === firstDraft.version_id
        && row.reason === 'Rollback plugin lifecycle to v1',
    );
    expect(rollbackActivationEvent).toMatchObject({
      action: 'activated',
      plugin_version_id: firstDraft.version_id,
    });

    const rolledBackEvent = approvalEvents.find((row) => row.action === 'rolled_back');
    expect(rolledBackEvent).toMatchObject({
      action: 'rolled_back',
      plugin_version_id: firstDraft.version_id,
      reason: 'Rollback plugin lifecycle to v1',
    });
    expect(rolledBackEvent.payload).toMatchObject({
      from_plugin_version_id: secondDraft.version_id,
      to_plugin_version_id: firstDraft.version_id,
      scope_type: 'tenant',
      scope_id: organization.id,
    });
  });

  test('credential rotation writes provider auth config and approval event for the active provider binding', async () => {
    const organization = await createOrganization(client, 'Integration Plugin Rotation Org');
    const builderUserId = await createUser(
      client,
      organization.id,
      `integration-plugin-rotation-builder-${randomUUID().slice(0, 8)}@example.com`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );
    const approverUserId = await createUser(
      client,
      organization.id,
      `integration-plugin-rotation-approver-${randomUUID().slice(0, 8)}@example.com`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );
    const workflowTemplateName = await createActiveTemplateName(
      organization.id,
      `integration-plugin-rotation-template-${Date.now()}`,
    );

    const firstVersion = await createActivatedPluginVersion({
      organizationId: organization.id,
      builderUserId,
      approverUserId,
      workflowTemplateName,
      pluginName: 'Lifecycle Rotation Plugin',
      routePath: '/plugins/lifecycle/rotation/v1',
      pluginKey: `lifecycle-rotation-${Date.now()}`,
      metadata: { release_marker: 'v1' },
      submitReason: 'Submit rotation test plugin v1',
      approveReason: 'Approve rotation test plugin v1',
      activateReason: 'Activate rotation test plugin v1',
    });
    const firstDraft = firstVersion.draft;
    const firstActivation = firstVersion.activation;
    const credentialsExpiry = new Date('2026-12-31T00:00:00.000Z');

    const rotation = await rotateCredentials(
      firstDraft.version_id,
      'bearer_token',
      { token: 'integration-plugin-rotation-secret' },
      credentialsExpiry,
      'Rotate provider credentials for active binding',
    );
    expect(rotation).toMatchObject({
      ok: true,
      plugin_id: firstDraft.plugin_id,
      plugin_version_id: firstDraft.version_id,
      provider_id: firstActivation.provider_id,
    });
    expect(rotation.auth_config_id).toBeTruthy();

    await setServiceContext(organization.id, approverUserId);

    const authConfig = await readProviderAuthConfig(rotation.auth_config_id);
    expect(authConfig).toMatchObject({
      id: rotation.auth_config_id,
      provider_id: firstActivation.provider_id,
      auth_type: 'bearer_token',
    });
    expect(new Date(authConfig.expires_at).toISOString()).toBe(credentialsExpiry.toISOString());

    const versionAfterRotation = await readVersion(firstDraft.version_id);
    expect(versionAfterRotation.auth_bindings).toMatchObject({
      latest_auth_config_id: rotation.auth_config_id,
      latest_auth_type: 'bearer_token',
    });

    const approvalEvents = await readApprovalEvents(firstDraft.plugin_id);
    expect(approvalEvents).toHaveLength(4);
    expect(approvalEvents.map((row) => row.action).sort()).toEqual([
      'submitted',
      'approved',
      'activated',
      'rotated_credentials',
    ].sort());

    const rotationEvent = approvalEvents.find((row) => row.action === 'rotated_credentials');
    expect(rotationEvent).toMatchObject({
      action: 'rotated_credentials',
      plugin_version_id: firstDraft.version_id,
      reason: 'Rotate provider credentials for active binding',
    });
    expect(rotationEvent.payload).toMatchObject({
      provider_id: firstActivation.provider_id,
      auth_config_id: rotation.auth_config_id,
      auth_type: 'bearer_token',
    });
  });
});
