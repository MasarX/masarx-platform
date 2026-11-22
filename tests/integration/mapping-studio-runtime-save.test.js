const { Pool } = require("pg");
const { randomUUID } = require("crypto");
const { loadEnv } = require("../../scripts/utils/load-env");
const {
  createClient,
  createSender,
  createUser,
  fetchDecisionLog,
  setAuthContext,
  setServiceContext,
  withFixtureAdminContext,
} = require("./helpers/tenant-utils");
const { upsertSettings } = require("../utils/policies");

loadEnv();

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || (["postgresql",":","/","/","postgres",":","postgres","@","localhost",":","54322","/","postgres"].join("")),
});

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

async function expectArtifactFailure(client, payload, expectedMessage) {
  await client.query('SAVEPOINT mapping_artifact_failure');
  try {
    await expect(
      client.query(
        'SELECT public.ui_upsert_mapping_artifact_v1($1::jsonb) AS result',
        [JSON.stringify(payload)],
      ),
    ).rejects.toThrow(expectedMessage);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT mapping_artifact_failure');
    await client.query('RELEASE SAVEPOINT mapping_artifact_failure');
  }
}

describeIfDb("mapping studio runtime save", () => {
  let client;

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  test.each([
    [[1, 0, 0, 0, 0], ["Review the imported records in the destination table or import history."]],
    [[0, 1, 0, 0, 0], ["Review the imported records in the destination table or import history."]],
    [[0, 0, 1, 0, 0], ["Download the annotated error export and correct the blocked or skipped rows before retrying."]],
    [[0, 0, 0, 1, 0], ["Download the annotated error export and correct the blocked or skipped rows before retrying."]],
    [[0, 0, 0, 0, 1], ["Download the annotated error export and correct the blocked or skipped rows before retrying."]],
    [[2, 0, 0, 1, 0], [
      "Download the annotated error export and correct the blocked or skipped rows before retrying.",
      "Review the imported records in the destination table or import history.",
    ]],
    [[0, 0, 0, 0, 0], []],
    [[null, null, null, null, null], []],
  ])("builds canonical execution next steps for counts %j under the worker role", async (counts, expected) => {
    await setServiceContext(client, randomUUID(), randomUUID());
    const result = await client.query(
      `SELECT public.tabular_import_execution_next_steps_v1($1, $2, $3, $4, $5) AS next_steps`,
      counts,
    );
    expect(result.rows[0].next_steps).toEqual(expected);
  });

  test("execution next-step helper is internal to the worker role", async () => {
    const result = await client.query(
      `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', $1, 'EXECUTE') AS service_role`,
      ["public.tabular_import_execution_next_steps_v1(integer,integer,integer,integer,integer)"],
    );
    expect(result.rows[0]).toEqual({ anon: false, authenticated: false, service_role: true });
  });

  test("upserts tabular import mapping artifact and persists a report row", async () => {
    const orgId = randomUUID();
    const slug = `mapping-studio-org-${orgId.slice(0, 8)}`;
    const userId = randomUUID();
    const correlationId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Mapping Studio Org', $2)`,
      [orgId, slug],
    );
    await createUser(client, orgId, `mapping-studio-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const artifactPayload = {
      organization_id: orgId,
      artifact: "tabular_import",
      target_resource_key: "shipments",
      notes: "Integration test tabular import profile",
      mapping_config: {
        fields: [
          { target_field: "external_id", source_path: "column:Order ID" },
          { target_field: "status", source_path: "column:Status" },
        ],
      },
    };

    const saveResult = await client.query(
      `SELECT public.ui_upsert_mapping_artifact_v1($1::jsonb) AS result`,
      [JSON.stringify(artifactPayload)],
    );

    const result = saveResult.rows[0].result;
    expect(result.mapping_config_id).toMatch(
      /^[0-9a-f-]{36}$/i,
    );

    const mappingRow = await client.query(
      `SELECT mapping_type, mapping_config
         FROM mapping_configs
        WHERE id = $1::uuid`,
      [result.mapping_config_id],
    );

    expect(mappingRow.rows[0].mapping_type).toBe("tabular_import");
    expect(mappingRow.rows[0].mapping_config.fields).toHaveLength(2);

    const reportPayload = {
      organization_id: orgId,
      artifact_type: "tabular_import",
      operation_kind: "tabular_import_execution",
      save_mode: "direct",
      status: "succeeded",
      primary_resource_type: "mapping_configs",
      primary_resource_id: result.mapping_config_id,
      correlation_id: correlationId,
      request_summary: {
        artifact: "tabular_import",
      },
      conversion_summary: {
        coercion_count: 0,
      },
      diagnostics_summary: {
        blocking_count: 0,
        warning_count: 0,
      },
      result_payload: result,
      decision_refs: {
        correlation_id: correlationId,
      },
      next_steps: ["Review saved mapping"],
    };

    const reportResult = await client.query(
      `SELECT public.ui_create_mapping_operation_report_v1($1::jsonb) AS report`,
      [JSON.stringify(reportPayload)],
    );

    expect(reportResult.rows[0].report.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(reportResult.rows[0].report.artifact_type).toBe("tabular_import");
    expect(reportResult.rows[0].report.operation_kind).toBe("tabular_import_execution");
    expect(reportResult.rows[0].report.primary_resource_id).toBe(result.mapping_config_id);
  });

  test("binds webhook inbound workflow through source policy without retired rule truth", async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    const sourceId = randomUUID();
    const initialMappingId = randomUUID();
    const workflowTemplateId = randomUUID();
    const slug = `mapping-webhook-org-${orgId.slice(0, 8)}`;

    await client.query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1::uuid, 'Mapping Webhook Org', $2)`,
      [orgId, slug],
    );
    await createUser(client, orgId, `mapping-webhook-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    await client.query(
      `INSERT INTO public.mapping_configs (
         id, organization_id, mapping_type, mapping_key, mapping_config, mapping_version, notes
       )
       VALUES ($1::uuid, $2::uuid, 'webhook_inbound', $3, '{}'::jsonb, 1, 'initial source mapping')`,
      [initialMappingId, orgId, `webhook-initial-${sourceId}`],
    );
    await client.query(
      `INSERT INTO public.webhook_sources (
         id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled
       )
       VALUES ($1::uuid, $2::uuid, $3, 'Mapping source', 'generic', $4, $5::uuid, TRUE)`,
      [sourceId, orgId, `mapping-source-${sourceId}`, `map_${sourceId}`, initialMappingId],
    );
    await withFixtureAdminContext(client, async (adminClient) => {
      await adminClient.query(
        `INSERT INTO public.workflow_templates (
           id, name, status, version, scope_type, scope_id, created_by
         )
         VALUES ($1::uuid, $2, 'active', 1, 'tenant', $3::uuid, $4::uuid)`,
        [workflowTemplateId, `mapping-template-${workflowTemplateId}`, orgId, userId],
      );
      await adminClient.query(
        `INSERT INTO public.workflow_template_steps (
           id, workflow_template_id, sequence_order, operation_name,
           operation_settings_category, transition_condition, handler_key,
           handler_version, metadata, manual_action_required, enabled
         )
         VALUES (
           gen_random_uuid(), $1::uuid, 0, 'create_shipment',
           'workflow', 'always', 'shipment_create',
           'v1', '{}'::jsonb, FALSE, TRUE
         )`,
        [workflowTemplateId],
      );
    });

    const savedMapping = {
      fields: [{ target_field: "external_id", source_path: "payload.id" }],
      target: "shipments.create",
      enabled: true,
      metadata: { canonical_intent: "shipment.create", mapping_profile: "plugin_studio_webhook_shipment_create_v1" },
      transforms: {
        shipment: { tracking_number: ["shipment.tracking_number", "tracking_number", "awb"] },
        recipient: { name: ["shipment.recipient.name", "recipient.name", "customer.name"] },
        address: { city: ["shipment.destination.city", "destination.city", "address.city"] },
      },
    };
    const saveResult = await client.query(
      `SELECT public.ui_upsert_mapping_artifact_v1($1::jsonb) AS result`,
      [JSON.stringify({
        organization_id: orgId,
        artifact: "webhook_inbound",
        webhook_source_id: sourceId,
        event_type: "shipment.created",
        mapping_config: savedMapping,
        workflow_binding: {
          workflow_template_id: workflowTemplateId,
          event_type: "shipment.created",
        },
      })],
    );

    const result = saveResult.rows[0].result;
    expect(result.webhook_source_id).toBe(sourceId);
    expect(result.workflow_template_id).toBe(workflowTemplateId);
    expect(result.workflow_binding_outcome).toEqual(
      expect.objectContaining({
        binding_kind: "webhook_ingest_policy",
        scope_type: "source",
        scope_id: sourceId,
        event_type: "shipment.create",
      }),
    );
    expect(result.resource_ids).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource_type: "mapping_configs" }),
        expect.objectContaining({ resource_type: "webhook_sources", resource_id: sourceId }),
        expect.objectContaining({ resource_type: "settings" }),
      ]),
    );
    expect(result.resource_ids).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ resource_type: "webhook_rules" })]),
    );

    const sourceRow = await client.query(
      `SELECT mapping_config_id FROM public.webhook_sources WHERE id = $1::uuid`,
      [sourceId],
    );
    expect(sourceRow.rows[0].mapping_config_id).toBe(result.mapping_config_id);

    const savedRow = await client.query(
      `SELECT mapping_config FROM public.mapping_configs WHERE id = $1::uuid`, [result.mapping_config_id],
    );
    expect(savedRow.rows[0].mapping_config).toEqual(savedMapping);
    const mapped = await client.query(
      `SELECT public.apply_mapping_config($1::jsonb, $2::uuid) AS payload`,
      [JSON.stringify({ awb: "SYNTHETIC-TRACK", customer: { name: "Synthetic recipient" },
        address: { city: "Riyadh" } }), result.mapping_config_id],
    );
    expect(mapped.rows[0].payload).toEqual({ shipment: { tracking_number: "SYNTHETIC-TRACK" },
      recipient: { name: "Synthetic recipient" }, address: { city: "Riyadh" } });

    const policyRow = await client.query(
      `SELECT policy
         FROM public.resolve_webhook_ingest_policy($1::uuid)
         LIMIT 1`,
      [sourceId],
    );
    expect(policyRow.rows[0].policy.workflow.templates_by_intent["shipment.create"].template_id)
      .toBe(workflowTemplateId);

    await setServiceContext(client, userId, orgId);
    const resolvedTemplate = await client.query(
      `SELECT public.resolve_webhook_followup_template_id_v1($1::jsonb, 'shipment.create') AS id`,
      [JSON.stringify(policyRow.rows[0].policy)],
    );
    expect(resolvedTemplate.rows[0].id).toBe(workflowTemplateId);

    const functionRow = await client.query(
      `SELECT pg_get_functiondef('public.ui_upsert_mapping_artifact_v1(jsonb)'::regprocedure) AS definition`,
    );
    expect(functionRow.rows[0].definition).not.toContain("webhook_rules");

    const staleContract = await client.query(
      `SELECT count(*)::int AS count
         FROM public.lookup_column_contracts
        WHERE table_schema = 'public'
          AND table_name = 'webhook_rules'`,
    );
    expect(staleContract.rows[0].count).toBe(0);
  });

  test("rejects unsafe workflow bindings and leaves create-new drafts unbound", async () => {
    const orgId = randomUUID();
    const foreignOrgId = randomUUID();
    const userId = randomUUID();
    const sourceId = randomUUID();
    const initialMappingId = randomUUID();
    const activeTemplateId = randomUUID();
    const inactiveTemplateId = randomUUID();
    const foreignTemplateId = randomUUID();
    const missingTemplateId = randomUUID();
    const sourceClientTemplateId = randomUUID();
    const siblingClientTemplateId = randomUUID();
    const sourceSenderTemplateId = randomUUID();
    const siblingSenderTemplateId = randomUUID();

    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES
        ($1::uuid, 'Binding Security Org', $2),
        ($3::uuid, 'Binding Foreign Org', $4)`,
      [orgId, `binding-security-${orgId.slice(0, 8)}`, foreignOrgId, `binding-foreign-${foreignOrgId.slice(0, 8)}`],
    );
    await createUser(client, orgId, `binding-security-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    const sourceClient = await createClient(client, orgId, `Binding source client ${sourceId}`);
    const siblingClient = await createClient(client, orgId, `Binding sibling client ${sourceId}`);
    const sourceSenderId = await createSender(client, sourceClient.id, `Binding source sender ${sourceId}`);
    const siblingSenderId = await createSender(client, siblingClient.id, `Binding sibling sender ${sourceId}`);
    await client.query(
      `INSERT INTO public.mapping_configs (
         id, organization_id, mapping_type, mapping_key, mapping_config, mapping_version
       ) VALUES ($1::uuid, $2::uuid, 'webhook_inbound', $3, '{}'::jsonb, 1)`,
      [initialMappingId, orgId, `binding-security-${sourceId}`],
    );
    await client.query(
      `INSERT INTO public.webhook_sources (
         id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, sender_id, enabled
       ) VALUES ($1::uuid, $2::uuid, $3, 'Binding security source', 'generic', $4, $5::uuid, $6::uuid, TRUE)`,
      [sourceId, orgId, `binding-source-${sourceId}`, `bind_${sourceId}`, initialMappingId, sourceSenderId],
    );
    await client.query(
      `INSERT INTO public.workflow_templates (
         id, name, status, version, scope_type, scope_id, created_by
       ) VALUES
         ($1::uuid, $2, 'active', 1, 'tenant', $4::uuid, $5::uuid),
         ($3::uuid, $6, 'draft', 1, 'tenant', $4::uuid, $5::uuid),
         ($7::uuid, $8, 'active', 1, 'tenant', $9::uuid, NULL)`,
      [
        activeTemplateId, `binding-active-${activeTemplateId}`,
        inactiveTemplateId, orgId, userId, `binding-draft-${inactiveTemplateId}`,
        foreignTemplateId, `binding-foreign-${foreignTemplateId}`, foreignOrgId,
      ],
    );
    await client.query(
      `INSERT INTO public.workflow_templates (
         id, name, status, version, scope_type, scope_id, created_by
       ) VALUES
         ($1::uuid, $2, 'active', 1, 'client', $3::uuid, $9::uuid),
         ($4::uuid, $5, 'active', 1, 'client', $6::uuid, $9::uuid),
         ($7::uuid, 'binding-source-sender', 'active', 1, 'sender', $8::uuid, $9::uuid),
         ($10::uuid, 'binding-sibling-sender', 'active', 1, 'sender', $11::uuid, $9::uuid)`,
      [
        sourceClientTemplateId, `binding-source-client-${sourceClientTemplateId}`, sourceClient.id,
        siblingClientTemplateId, `binding-sibling-client-${siblingClientTemplateId}`, siblingClient.id,
        sourceSenderTemplateId, sourceSenderId, userId, siblingSenderTemplateId, siblingSenderId,
      ],
    );
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const basePayload = {
      organization_id: orgId,
      artifact: "webhook_inbound",
      webhook_source_id: sourceId,
      mapping_config: { fields: [] },
    };

    await expectArtifactFailure(client, {
      ...basePayload,
      workflow_binding: { workflow_template_id: missingTemplateId, event_type: "shipment.created" },
    }, /not found/i);
    await expectArtifactFailure(client, {
      ...basePayload,
      workflow_binding: { workflow_template_id: inactiveTemplateId, event_type: "shipment.created" },
    }, /not active/i);
    await expectArtifactFailure(client, {
      ...basePayload,
      workflow_binding: { workflow_template_id: foreignTemplateId, event_type: "shipment.created" },
    }, /outside caller scope|outside source organization/i);
    await expectArtifactFailure(client, {
      ...basePayload,
      workflow_binding: { mode: "attach_existing", workflow_template_id: siblingClientTemplateId, event_type: "shipment.created" },
    }, /outside exact source lineage/i);
    await expectArtifactFailure(client, {
      ...basePayload,
      workflow_binding: { mode: "attach_existing", workflow_template_id: siblingSenderTemplateId, event_type: "shipment.created" },
    }, /outside exact source lineage/i);
    await expectArtifactFailure(client, {
      ...basePayload,
      workflow_binding: { mode: "attach_existing" },
    }, /attach_existing requires workflow_template_id/i);
    await expectArtifactFailure(client, {
      ...basePayload,
      workflow_binding: { mode: "create_new" },
    }, /create_new requires template_name/i);
    await expectArtifactFailure(client, {
      ...basePayload,
      workflow_binding: { mode: "future_mode", workflow_template_id: activeTemplateId },
    }, /unsupported workflow binding mode/i);
    await expectArtifactFailure(client, {
      ...basePayload,
      workflow_binding: { mode: "create_new", template_name: "contradictory", workflow_template_id: activeTemplateId },
    }, /create_new contradicts workflow_template_id/i);

    const exactClientBinding = await client.query(
      `SELECT public.ui_upsert_mapping_artifact_v1($1::jsonb) AS result`,
      [JSON.stringify({
        ...basePayload,
        workflow_binding: { mode: "attach_existing", workflow_template_id: sourceClientTemplateId, event_type: "shipment.created" },
      })],
    );
    expect(exactClientBinding.rows[0].result.workflow_template_id).toBe(sourceClientTemplateId);
    const exactSenderBinding = await client.query(
      `SELECT public.ui_upsert_mapping_artifact_v1($1::jsonb) AS result`,
      [JSON.stringify({
        ...basePayload,
        workflow_binding: { mode: "attach_existing", workflow_template_id: sourceSenderTemplateId, event_type: "shipment.created" },
      })],
    );
    expect(exactSenderBinding.rows[0].result.workflow_template_id).toBe(sourceSenderTemplateId);
    await expectArtifactFailure(client, {
      ...basePayload,
      workflow_binding: { workflow_template_id: activeTemplateId, event_type: "shipment.updated" },
    }, /unsupported or unresolved shipment intent/i);
    await expectArtifactFailure(client, {
      ...basePayload,
      workflow_binding: { workflow_template_id: activeTemplateId, event_type: "not.a.shipment.intent" },
    }, /unsupported or unresolved shipment intent/i);

    const sourcePolicyBefore = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT count(*)::int AS count FROM public.settings
        WHERE category = 'webhook_ingest_policy' AND scope_type = 'source' AND scope_id = $1::uuid`,
      [sourceId],
    ));
    const created = await client.query(
      `SELECT public.ui_upsert_mapping_artifact_v1($1::jsonb) AS result`,
      [JSON.stringify({
        ...basePayload,
        workflow_binding: {
          mode: "create_new",
          template_name: `binding-draft-created-${sourceId}`,
          event_type: "shipment.created",
        },
      })],
    );
    expect(created.rows[0].result.workflow_binding_outcome).toEqual(expect.objectContaining({
      created: true,
      binding_status: "pending_activation",
      policy_binding_written: false,
    }));
    const draftId = created.rows[0].result.workflow_template_id;
    const draft = await client.query(
      `SELECT status FROM public.workflow_templates WHERE id = $1::uuid`,
      [draftId],
    );
    expect(draft.rows[0].status).toBe("draft");
    const sourcePolicyAfter = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT count(*)::int AS count FROM public.settings
        WHERE category = 'webhook_ingest_policy' AND scope_type = 'source' AND scope_id = $1::uuid`,
      [sourceId],
    ));
    expect(sourcePolicyAfter.rows[0].count).toBe(sourcePolicyBefore.rows[0].count);
    await client.query('SAVEPOINT authenticated_resolver_denial');
    try {
      await expect(
        client.query(
          `SELECT public.resolve_webhook_followup_template_id_v1($1::jsonb, 'shipment.create') AS id`,
          [JSON.stringify({ workflow: { templates_by_intent: { "shipment.create": { template_id: activeTemplateId } } } })],
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT authenticated_resolver_denial');
      await client.query('RELEASE SAVEPOINT authenticated_resolver_denial');
    }
    await setServiceContext(client, userId, orgId);
    const serviceResolution = await client.query(
      `SELECT public.resolve_webhook_followup_template_id_v1($1::jsonb, 'shipment.create') AS id`,
      [JSON.stringify({ workflow: { templates_by_intent: { "shipment.create": { template_id: activeTemplateId } } } })],
    );
    expect(serviceResolution.rows[0].id).toBe(activeTemplateId);
    const inactiveResolution = await client.query(
      `SELECT public.resolve_active_workflow_template_ref_v1($1::text) AS id`,
      [draftId],
    );
    expect(inactiveResolution.rows[0].id).toBeNull();
  });

  test("accepts caller-scoped same-organization client and sender templates for api_outbound", async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'API binding scope org', $2)`,
      [orgId, `api-binding-scope-${orgId.slice(0, 8)}`],
    );
    await createUser(client, orgId, `api-binding-scope-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    const clientFixture = await createClient(client, orgId, `API binding client ${orgId}`);
    const senderId = await createSender(client, clientFixture.id, `API binding sender ${orgId}`);
    const clientTemplateId = randomUUID();
    const senderTemplateId = randomUUID();
    await client.query(
      `INSERT INTO public.workflow_templates (
         id, name, status, version, scope_type, scope_id, created_by
       ) VALUES
         ($1::uuid, $2, 'active', 1, 'client', $3::uuid, $6::uuid),
         ($4::uuid, $5, 'active', 1, 'sender', $7::uuid, $6::uuid)`,
      [
        clientTemplateId, `api-client-template-${clientTemplateId}`, clientFixture.id,
        senderTemplateId, `api-sender-template-${senderTemplateId}`, userId, senderId,
      ],
    );
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    for (const workflowTemplateId of [clientTemplateId, senderTemplateId]) {
      const saved = await client.query(
        `SELECT public.ui_upsert_mapping_artifact_v1($1::jsonb) AS result`,
        [JSON.stringify({
          organization_id: orgId,
          artifact: "api_outbound",
          mapping_key: `api-outbound-binding-${workflowTemplateId}`,
          mapping_config: { fields: [] },
          workflow_binding: {
            mode: "attach_existing",
            workflow_template_id: workflowTemplateId,
          },
        })],
      );
      expect(saved.rows[0].result.workflow_template_id).toBe(workflowTemplateId);
    }
  });

  test("keeps mapping, operation-template, and route writes inside exact caller ownership", async () => {
    const orgId = randomUUID();
    const foreignOrgId = randomUUID();
    const userId = randomUUID();
    const providerId = randomUUID();
    const foreignProviderId = randomUUID();
    const foreignMappingId = randomUUID();
    const globalMappingId = randomUUID();
    const sourceMappingId = randomUUID();
    const ownedMappingId = randomUUID();
    const operationTemplateId = randomUUID();
    const ownedOperationTemplateId = randomUUID();
    const platformUserId = randomUUID();
    const packId = randomUUID();
    const sourceId = randomUUID();

    await client.query(
      `INSERT INTO public.organizations (id, name, slug) VALUES
         ($1::uuid, 'Mapping owner org', $2),
         ($3::uuid, 'Mapping foreign org', $4)`,
      [
        orgId, `mapping-owner-${orgId.slice(0, 8)}`,
        foreignOrgId, `mapping-foreign-${foreignOrgId.slice(0, 8)}`,
      ],
    );
    await createUser(client, orgId, `mapping-owner-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await createUser(client, orgId, `mapping-platform-${platformUserId.slice(0, 8)}@example.com`, {
      id: platformUserId,
      userType: "super_admin",
      accessScopeType: "platform",
    });
    const ownedClient = await createClient(client, orgId, `Mapping owner client ${orgId}`);
    const ownedSenderId = await createSender(client, ownedClient.id, `Mapping owner sender ${orgId}`);

    await client.query(
      `INSERT INTO public.providers (id, organization_id, name, provider_type) VALUES
         ($1::uuid, $2::uuid, 'Mapping owned provider', 'http'),
         ($3::uuid, $4::uuid, 'Mapping foreign provider', 'http')`,
      [providerId, orgId, foreignProviderId, foreignOrgId],
    );
    await client.query(
      `INSERT INTO public.mapping_configs (
         id, organization_id, mapping_type, mapping_key, mapping_config, mapping_version
       ) VALUES
         ($1::uuid, $2::uuid, 'provider_response', $3, '{"owner":"foreign"}'::jsonb, 1),
         ($4::uuid, NULL, 'provider_response', $5, '{"owner":"global"}'::jsonb, 1),
         ($6::uuid, $7::uuid, 'webhook_inbound', $8, '{}'::jsonb, 1),
         ($9::uuid, $7::uuid, 'provider_response', $10, '{}'::jsonb, 1)`,
      [
        foreignMappingId, foreignOrgId, `foreign-key-${foreignMappingId}`,
        globalMappingId, `global-key-${globalMappingId}`,
        sourceMappingId, orgId, `source-key-${sourceMappingId}`,
        ownedMappingId, `owned-provider-response-${ownedMappingId}`,
      ],
    );
    await client.query(
      `INSERT INTO public.operation_templates (
         id, provider_id, operation_name, handler_key, method, url_template,
         headers_template, body_template, mapping_config_id, timeout_seconds, call_type
       ) VALUES
         (
           $1::uuid, $2::uuid, $3, 'outbound_http', 'POST', 'https://foreign.example.test',
           '{}'::jsonb, '{}'::jsonb, $7::uuid, 30, 'provider_api'
         ),
         (
           $4::uuid, $5::uuid, $6, 'outbound_http', 'POST', 'https://owned.example.test',
           '{}'::jsonb, '{}'::jsonb, $8::uuid, 30, 'provider_api'
         )`,
      [
        operationTemplateId, foreignProviderId, `mapping-foreign-operation-${operationTemplateId}`,
        ownedOperationTemplateId, providerId, `mapping-owned-operation-${ownedOperationTemplateId}`,
        foreignMappingId, ownedMappingId,
      ],
    );
    await client.query(
      `INSERT INTO public.webhook_sources (
         id, organization_id, source_identifier, name, provider_type, auth_token,
         mapping_config_id, sender_id, enabled
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'Mapping owned source', 'generic', $4,
         $5::uuid, $6::uuid, TRUE
       )`,
      [sourceId, orgId, `mapping-source-${sourceId}`, `mapping_${sourceId}`, sourceMappingId, ownedSenderId],
    );
    await client.query(
      `INSERT INTO public.api_route_packs (
         id, name, enabled, scope_type, scope_id
       ) VALUES ($1::uuid, $2, TRUE, 'tenant', $3::uuid)`,
      [packId, `mapping-owner-pack-${packId}`, orgId],
    );

    const routeScopes = [
      ["global", null],
      ["tenant", foreignOrgId],
      ["tenant", orgId],
      ["client", ownedClient.id],
      ["sender", ownedSenderId],
      ["source", sourceId],
    ];
    const routeIds = new Map();
    for (const [scopeType, scopeId] of routeScopes) {
      const routeId = randomUUID();
      routeIds.set(`${scopeType}:${scopeId}`, routeId);
      await client.query(
        `INSERT INTO public.api_routes (
           id, pack_id, route_name, enabled, method, path_template,
           scope_type, scope_id, provider_id, policy
         ) VALUES (
           $1::uuid, $2::uuid, $3, TRUE, 'POST', $4,
           $5, $6::uuid, $7::uuid, '{}'::jsonb
         )`,
        [
          routeId,
          packId,
          `mapping-owner-route-${routeId}`,
          `/mapping-owner/${routeId}`,
          scopeType,
          scopeId,
          providerId,
        ],
      );
    }

    const responseCollisionKey = `response-primary-${orgId}`;
    await client.query(
      `INSERT INTO public.mapping_configs (
         organization_id, mapping_type, mapping_key, mapping_config, mapping_version
       ) VALUES ($1::uuid, 'provider_response', $2, '{"owner":"foreign-response"}'::jsonb, 1)`,
      [foreignOrgId, `provider_response::${responseCollisionKey}::${orgId}`],
    );

    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const payload = (mappingKey, extra = {}) => ({
      organization_id: orgId,
      artifact: "api_outbound",
      mapping_key: mappingKey,
      mapping_config: { owner: "caller" },
      ...extra,
    });

    for (const mappingConfigId of [foreignMappingId, globalMappingId]) {
      await expectArtifactFailure(
        client,
        payload(`explicit-${mappingConfigId}`, { mapping_config_id: mappingConfigId }),
        /mapping config .* not found for organization/i,
      );
    }
    for (const mappingKey of [`foreign-key-${foreignMappingId}`, `global-key-${globalMappingId}`]) {
      await expectArtifactFailure(
        client,
        payload(mappingKey),
        /mapping key .* owned by another organization/i,
      );
    }
    await expectArtifactFailure(
      client,
      payload(`response-id-${orgId}`, {
        response_mapping_config_id: foreignMappingId,
        response_mapping_config: { owner: "caller" },
      }),
      /response mapping config .* not found for organization/i,
    );
    await expectArtifactFailure(
      client,
      payload(responseCollisionKey, { response_mapping_config: { owner: "caller" } }),
      /response mapping key is owned by another organization/i,
    );
    await expectArtifactFailure(
      client,
      payload(`foreign-operation-${orgId}`, {
        operation_template_id: operationTemplateId,
        request_config: { method: "PATCH" },
      }),
      /operation template .* not found/i,
    );

    const operationSaved = await client.query(
      `SELECT public.ui_upsert_mapping_artifact_v1($1::jsonb) AS result`,
      [JSON.stringify(payload(`owned-operation-${orgId}`, {
        operation_template_id: ownedOperationTemplateId,
        request_config: { method: "PATCH" },
      }))],
    );
    expect(operationSaved.rows[0].result.operation_template_id).toBe(ownedOperationTemplateId);
    const ownedOperation = await client.query(
      `SELECT public.ui_get_resource_v1('operation_templates', $1::uuid) AS item`,
      [ownedOperationTemplateId],
    );
    expect(ownedOperation.rows[0].item.method).toBe("PATCH");

    for (const routeId of [routeIds.get("global:null"), routeIds.get(`tenant:${foreignOrgId}`)]) {
      await expectArtifactFailure(
        client,
        payload(`denied-route-${routeId}`, { api_route_id: routeId }),
        /api route .* not found/i,
      );
    }

    for (const routeId of [
      routeIds.get(`tenant:${orgId}`),
      routeIds.get(`client:${ownedClient.id}`),
      routeIds.get(`sender:${ownedSenderId}`),
      routeIds.get(`source:${sourceId}`),
    ]) {
      const saved = await client.query(
        `SELECT public.ui_upsert_mapping_artifact_v1($1::jsonb) AS result`,
        [JSON.stringify(payload(`owned-route-${routeId}`, { api_route_id: routeId }))],
      );
      expect(saved.rows[0].result.api_route_id).toBe(routeId);
    }

    await setAuthContext(client, platformUserId, {
      organization_id: orgId,
      scope_type: "platform",
      scope_id: null,
    });
    const platformSaved = await client.query(
      `SELECT public.ui_upsert_mapping_artifact_v1($1::jsonb) AS result`,
      [JSON.stringify(payload(`platform-global-route-${orgId}`, {
        api_route_id: routeIds.get("global:null"),
      }))],
    );
    expect(platformSaved.rows[0].result.api_route_id).toBe(routeIds.get("global:null"));

    const protectedRows = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT id, organization_id, mapping_config
         FROM public.mapping_configs
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[foreignMappingId, globalMappingId]],
    ));
    expect(protectedRows.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: foreignMappingId, organization_id: foreignOrgId, mapping_config: { owner: "foreign" } }),
        expect.objectContaining({ id: globalMappingId, organization_id: null, mapping_config: { owner: "global" } }),
      ]),
    );
  });

  test("lists named tabular import profiles and cancels staged runs", async () => {
    const orgId = randomUUID();
    const slug = `mapping-runtime-org-${orgId.slice(0, 8)}`;
    const userId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Runtime Save Org', $2)`,
      [orgId, slug],
    );
    await createUser(client, orgId, `mapping-runtime-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const artifactPayload = {
      organization_id: orgId,
      artifact: "tabular_import",
      target_resource_key: "recipients",
      notes: "Recipients reusable import profile",
      mapping_config: {
        resource_key: "recipients",
        profile_name: "Recipient import",
        profile_slug: "recipient-import",
        header_fingerprint: "external_id|status",
        sheet_hint: "Sheet1",
        write_mode: "create",
        field_rules: [
          { source_column: "External ID", target_field: "external_id", enabled: true },
          { source_column: "Status", target_field: "status", enabled: true },
        ],
      },
    };

    const saveProfileResult = await client.query(
      `SELECT public.ui_upsert_mapping_artifact_v1($1::jsonb) AS result`,
      [JSON.stringify(artifactPayload)],
    );
    expect(saveProfileResult.rows[0].result.mapping_config_id).toMatch(/^[0-9a-f-]{36}$/i);

    const profilesResult = await client.query(
      `SELECT * FROM public.ui_tabular_import_profiles_v1($1::text)`,
      ["recipients"],
    );

    expect(profilesResult.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profile_name: "Recipient import",
          header_fingerprint: "external_id|status",
          write_mode: "create",
        }),
      ]),
    );

    const runId = randomUUID();
    await client.query(
      `INSERT INTO public.tabular_import_runs (
         id,
         organization_id,
         resource_key,
         relation_name,
         write_mode,
         status,
         profile_name,
         header_fingerprint,
         sheet_name,
         source_format,
         source_file_name,
         total_rows,
         will_create,
         summary,
         created_by,
         updated_by
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         'recipients',
         'public.recipients',
         'create',
         'prepared',
         'Recipient import',
         'external_id|status',
         'Sheet1',
         'csv',
         'recipients.csv',
         1,
         1,
         $3::jsonb,
         $4::uuid,
         $4::uuid
       )`,
      [
        runId,
        orgId,
        JSON.stringify({
          resolved_rules: [
            { source_column: "External ID", target_field: "external_id", enabled: true },
            { source_column: "Status", target_field: "status", enabled: true },
          ],
          unresolved_targets: [],
          headers: ["External ID", "Status"],
        }),
        userId,
      ],
    );
    await client.query(
      `INSERT INTO public.tabular_import_run_rows (
         run_id,
         organization_id,
         row_number,
         action,
         execution_status,
         original_row,
         mapped_row,
         diagnostics,
         coercions,
         reason_codes,
         reason_messages,
         metadata
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         1,
         'create',
         'queued',
         $3::jsonb,
         $4::jsonb,
         '[]'::jsonb,
         '[]'::jsonb,
         '[]'::jsonb,
         '[]'::jsonb,
         '{}'::jsonb
       )`,
      [
        runId,
        orgId,
        JSON.stringify({ "External ID": "ext-1", Status: "active" }),
        JSON.stringify({ external_id: "ext-1", status: "active" }),
      ],
    );

    const getRunResult = await client.query(
      `SELECT public.ui_get_tabular_import_run_v1($1::uuid) AS run`,
      [runId],
    );

    expect(getRunResult.rows[0].run.id).toBe(runId);
    expect(getRunResult.rows[0].run.status).toBe("prepared");
    expect(getRunResult.rows[0].run.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row_number: 1,
          action: "create",
          execution_status: "queued",
        }),
      ]),
    );

    const cancelReason = "Cancel staged recipient import after verifying runtime save";
    const cancelResult = await client.query(
      `SELECT public.ui_cancel_tabular_import_run_v1($1::uuid, $2::text) AS run`,
      [runId, cancelReason],
    );

    expect(cancelResult.rows[0].run.id).toBe(runId);
    expect(cancelResult.rows[0].run.status).toBe("canceled");
    expect(cancelResult.rows[0].run.summary.cancel_reason).toBe(cancelReason);
    expect(cancelResult.rows[0].run.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row_number: 1,
          execution_status: "canceled",
        }),
      ]),
    );
  });

  test("prepare blocks tenant-scope recipient imports without client context", async () => {
    const orgId = randomUUID();
    const slug = `mapping-prepare-org-${orgId.slice(0, 8)}`;
    const userId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Runtime Prepare Org', $2)`,
      [orgId, slug],
    );
    await createUser(client, orgId, `mapping-prepare-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const prepareResult = await client.query(
      `SELECT public.tabular_import_prepare_v1($1::jsonb) AS run`,
      [
        JSON.stringify({
          resource_key: "recipients",
          source_format: "csv",
          source_file_name: "recipients-no-client.csv",
          header_fingerprint: "email|external_id|name|preferred_language",
          headers: ["External Id", "Name", "Email", "Preferred Language"],
          rules: [
            { source_column: "External Id", target_field: "external_id", enabled: true },
            { source_column: "Name", target_field: "name", enabled: true },
            { source_column: "Email", target_field: "email", enabled: true },
            { source_column: "Preferred Language", target_field: "preferred_language", enabled: true },
          ],
          rows: [
            {
              "External Id": " ext-blocked-1 ",
              Name: "Blocked Recipient",
              Email: "blocked@example.com",
              "Preferred Language": " ar ",
            },
          ],
        }),
      ],
    );

    expect(prepareResult.rows[0].run.blocked_count).toBe(1);
    expect(prepareResult.rows[0].run.blocking_diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "target_unresolved",
          fieldPath: "client_id",
          blocking: true,
        }),
      ]),
    );
    expect(prepareResult.rows[0].run.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "block",
          mapped_row: expect.objectContaining({
            external_id: "ext-blocked-1",
            preferred_language: "ar",
          }),
        }),
      ]),
    );
  });

  test("prepare trims recipient values and accepts preferred_language when client_id is mapped", async () => {
    const orgId = randomUUID();
    const slug = `mapping-prepare-ok-org-${orgId.slice(0, 8)}`;
    const userId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Runtime Prepare Success Org', $2)`,
      [orgId, slug],
    );
    const clientScope = await createClient(client, orgId, "Prepare Client");
    await createUser(client, orgId, `mapping-prepare-ok-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const prepareResult = await client.query(
      `SELECT api.tabular_import_prepare_v1($1::jsonb) AS run`,
      [
        JSON.stringify({
          resource_key: "recipients",
          source_format: "csv",
          source_file_name: "recipients-valid.csv",
          header_fingerprint: "client_id|email|external_id|name|phone_number|preferred_language",
          headers: ["Client Id", "External Id", "Name", "Email", "Phone Number", "Preferred Language"],
          rules: [
            { source_column: "Client Id", target_field: "client_id", enabled: true },
            { source_column: "External Id", target_field: "external_id", enabled: true },
            { source_column: "Name", target_field: "name", enabled: true },
            { source_column: "Email", target_field: "email", enabled: true },
            { source_column: "Phone Number", target_field: "phone_number", enabled: true },
            { source_column: "Preferred Language", target_field: "preferred_language", enabled: true },
          ],
          rows: [
            {
              "Client Id": clientScope.id,
              "External Id": " ext-ready-1 ",
              Name: "Ready Recipient",
              Email: "ready@example.com",
              "Phone Number": " +12025550123 ",
              "Preferred Language": " ar ",
            },
          ],
        }),
      ],
    );

    expect(prepareResult.rows[0].run.blocked_count).toBe(0);
    expect(prepareResult.rows[0].run.will_create).toBe(1);
    expect(prepareResult.rows[0].run.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "create",
          mapped_row: expect.objectContaining({
            client_id: clientScope.id,
            external_id: "ext-ready-1",
            phone_number: "+12025550123",
            preferred_language: "ar",
          }),
        }),
      ]),
    );
    expect(prepareResult.rows[0].run.automatic_corrections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target_field: "external_id" }),
        expect.objectContaining({ target_field: "phone_number" }),
        expect.objectContaining({ target_field: "preferred_language" }),
      ]),
    );
  });

  test(
    "prepare applies one shared value across all rows for schema fields missing from the file",
    async () => {
    const orgId = randomUUID();
    const slug = `mapping-prepare-fixed-org-${orgId.slice(0, 8)}`;
    const userId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Runtime Prepare Fixed Org', $2)`,
      [orgId, slug],
    );
    const clientScope = await createClient(client, orgId, "Prepare Fixed Client");
    await createUser(client, orgId, `mapping-prepare-fixed-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const prepareResult = await client.query(
      `SELECT public.tabular_import_prepare_v1($1::jsonb) AS run`,
      [
        JSON.stringify({
          resource_key: "recipients",
          source_format: "csv",
          source_file_name: "recipients-fixed-values.csv",
          header_fingerprint: "client_id|email|external_id|name",
          headers: ["Client Id", "External Id", "Name", "Email"],
          rules: [
            { source_column: "Client Id", target_field: "client_id", enabled: true },
            { source_column: "External Id", target_field: "external_id", enabled: true },
            { source_column: "Name", target_field: "name", enabled: true },
            { source_column: "Email", target_field: "email", enabled: true },
            { target_field: "phone_number", value_mode: "fixed", fixed_value: "+12025550123", enabled: true },
            { target_field: "preferred_language", value_mode: "fixed", fixed_value: "en", enabled: true },
          ],
          rows: [
            {
              "Client Id": clientScope.id,
              "External Id": "ext-fixed-1",
              Name: "Fixed Recipient",
              Email: "fixed@example.com",
            },
          ],
        }),
      ],
    );

    expect(prepareResult.rows[0].run.blocked_count).toBe(0);
    expect(prepareResult.rows[0].run.unresolved_targets).toEqual([]);
    expect(prepareResult.rows[0].run.resolved_rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_field: "phone_number",
          value_mode: "fixed",
          fixed_value: "+12025550123",
        }),
        expect.objectContaining({
          target_field: "preferred_language",
          value_mode: "fixed",
          fixed_value: "en",
        }),
      ]),
    );
    expect(prepareResult.rows[0].run.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "create",
          mapped_row: expect.objectContaining({
            client_id: clientScope.id,
            external_id: "ext-fixed-1",
            phone_number: "+12025550123",
            preferred_language: "en",
          }),
        }),
      ]),
    );
    },
    30_000,
  );

  test("ui_read_registry exposes FK-backed import references for relation fields", async () => {
    const orgId = randomUUID();
    const slug = `mapping-registry-reference-org-${orgId.slice(0, 8)}`;
    const userId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Registry Reference Org', $2)`,
      [orgId, slug],
    );
    await createUser(client, orgId, `mapping-registry-reference-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const registryResult = await client.query(
      `SELECT public.ui_read_registry_v1() AS registry`,
    );
    const registry = registryResult.rows[0].registry;
    const recipientsResource = Array.isArray(registry?.resources)
      ? registry.resources.find((resource) => resource?.key === "recipients")
      : null;
    const clientColumn = Array.isArray(recipientsResource?.columns)
      ? recipientsResource.columns.find((column) => column?.key === "client_id")
      : null;
    const shipmentsResource = Array.isArray(registry?.resources)
      ? registry.resources.find((resource) => resource?.key === "shipments")
      : null;
    const senderColumn = Array.isArray(shipmentsResource?.columns)
      ? shipmentsResource.columns.find((column) => column?.key === "sender_id")
      : null;

    expect(recipientsResource).toBeTruthy();
    expect(clientColumn).toBeTruthy();
    expect(clientColumn.import.reference).toEqual(
      expect.objectContaining({
        resource: "clients",
        relation: "public.clients",
        id_column: "id",
      }),
    );
    expect(clientColumn.import.reference.display_columns).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    expect(shipmentsResource).toBeTruthy();
    expect(senderColumn).toBeTruthy();
    expect(senderColumn.import.reference).toEqual(
      expect.objectContaining({
        resource: "senders",
        relation: "public.senders",
        id_column: "id",
      }),
    );
  });

  test("prepare applies row-specific overrides before final validation", async () => {
    const orgId = randomUUID();
    const slug = `mapping-row-override-org-${orgId.slice(0, 8)}`;
    const userId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Runtime Row Override Org', $2)`,
      [orgId, slug],
    );
    const clientScope = await createClient(client, orgId, "Row Override Client");
    await createUser(client, orgId, `mapping-row-override-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const prepareResult = await client.query(
      `SELECT public.tabular_import_prepare_v1($1::jsonb) AS run`,
      [
        JSON.stringify({
          resource_key: "recipients",
          source_format: "csv",
          source_file_name: "recipients-row-overrides.csv",
          header_fingerprint: "client_id|email|external_id|name|phone_number|preferred_language",
          headers: ["Client Id", "External Id", "Name", "Email", "Phone Number", "Preferred Language"],
          rules: [
            { source_column: "Client Id", target_field: "client_id", enabled: true },
            { source_column: "External Id", target_field: "external_id", enabled: true },
            { source_column: "Name", target_field: "name", enabled: true },
            { source_column: "Email", target_field: "email", enabled: true },
            { source_column: "Phone Number", target_field: "phone_number", enabled: true },
            { source_column: "Preferred Language", target_field: "preferred_language", enabled: true },
          ],
          row_overrides: {
            "1": {
              preferred_language: "ar",
            },
          },
          rows: [
            {
              "Client Id": clientScope.id,
              "External Id": "ext-row-override-1",
              Name: "Row Override Recipient",
              Email: "row.override@example.com",
              "Phone Number": "+966500001111",
              "Preferred Language": "legacy_language",
            },
          ],
        }),
      ],
    );

    expect(prepareResult.rows[0].run.blocked_count).toBe(0);
    expect(prepareResult.rows[0].run.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "create",
          mapped_row: expect.objectContaining({
            client_id: clientScope.id,
            preferred_language: "ar",
          }),
        }),
      ]),
    );

    const runSummaryResult = await client.query(
      `SELECT summary
         FROM public.tabular_import_runs
        WHERE id = $1::uuid`,
      [prepareResult.rows[0].run.run_id],
    );

    expect(runSummaryResult.rows[0].summary).toEqual(
      expect.objectContaining({
        row_override_count: 1,
      }),
    );
  });

  test("prepare blocks recipient imports when a non-null relation field is missing from the file", async () => {
    const orgId = randomUUID();
    const slug = `mapping-prepare-required-org-${orgId.slice(0, 8)}`;
    const userId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Runtime Prepare Required Org', $2)`,
      [orgId, slug],
    );
    const clientScope = await createClient(client, orgId, "Prepare Required Client");
    await createUser(client, orgId, `mapping-prepare-required-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const prepareResult = await client.query(
      `SELECT public.tabular_import_prepare_v1($1::jsonb) AS run`,
      [
        JSON.stringify({
          resource_key: "recipients",
          source_format: "csv",
          source_file_name: "recipients-missing-phone.csv",
          header_fingerprint: "client_id|email|external_id|name|preferred_language",
          headers: ["Client Id", "External Id", "Name", "Email", "Preferred Language"],
          rules: [
            { source_column: "Client Id", target_field: "client_id", enabled: true },
            { source_column: "External Id", target_field: "external_id", enabled: true },
            { source_column: "Name", target_field: "name", enabled: true },
            { source_column: "Email", target_field: "email", enabled: true },
            { source_column: "Preferred Language", target_field: "preferred_language", enabled: true },
          ],
          rows: [
            {
              "Client Id": clientScope.id,
              "External Id": "ext-missing-phone-1",
              Name: "Missing Phone Recipient",
              Email: "missing.phone@example.com",
              "Preferred Language": "ar",
            },
          ],
        }),
      ],
    );

    expect(prepareResult.rows[0].run.blocked_count).toBe(1);
    expect(prepareResult.rows[0].run.blocking_diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "required_field_missing",
          fieldPath: "phone_number",
          blocking: true,
        }),
      ]),
    );
    expect(prepareResult.rows[0].run.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "block",
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              code: "required_field_missing",
              fieldPath: "phone_number",
            }),
          ]),
        }),
      ]),
    );
  });

  test("starts a prepared run under authenticated context and creates a queued task", async () => {
    const orgId = randomUUID();
    const slug = `mapping-start-org-${orgId.slice(0, 8)}`;
    const userId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Runtime Start Org', $2)`,
      [orgId, slug],
    );
    await createUser(client, orgId, `mapping-start-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await upsertSettings(
      "task_type_catalog",
      "tenant",
      orgId,
      {
        version: 1,
        task_types: [
          {
            key: "route_stop_execute",
            name: "Route Stop Execute",
            enabled: true,
            default_priority: 50,
            default_queue_key: "default",
          },
        ],
      },
      "integration test stale task_type_catalog override",
      client,
    );
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const runId = randomUUID();
    await client.query(
      `INSERT INTO public.tabular_import_runs (
         id,
         organization_id,
         resource_key,
         relation_name,
         write_mode,
         status,
         profile_name,
         header_fingerprint,
         sheet_name,
         source_format,
         source_file_name,
         total_rows,
         will_create,
         summary,
         created_by,
         updated_by
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         'recipients',
         'public.recipients',
         'create',
         'prepared',
         'Recipient import',
         'email|external_id|name',
         'Sheet1',
         'csv',
         'recipients.csv',
         1,
         1,
         $3::jsonb,
         $4::uuid,
         $4::uuid
       )`,
      [
        runId,
        orgId,
        JSON.stringify({
          resolved_rules: [
            { source_column: "External Id", target_field: "external_id", enabled: true },
            { source_column: "Name", target_field: "name", enabled: true },
            { source_column: "Email", target_field: "email", enabled: true },
          ],
          unresolved_targets: [],
          headers: ["External Id", "Name", "Email"],
        }),
        userId,
      ],
    );
    await client.query(
      `INSERT INTO public.tabular_import_run_rows (
         run_id,
         organization_id,
         row_number,
         action,
         execution_status,
         original_row,
         mapped_row,
         diagnostics,
         coercions,
         reason_codes,
         reason_messages,
         metadata
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         1,
         'create',
         'queued',
         $3::jsonb,
         $4::jsonb,
         '[]'::jsonb,
         '[]'::jsonb,
         '[]'::jsonb,
         '[]'::jsonb,
         '{}'::jsonb
       )`,
      [
        runId,
        orgId,
        JSON.stringify({
          "External Id": "ext-start-1",
          Name: "Queued Recipient",
          Email: "queued@example.com",
        }),
        JSON.stringify({
          external_id: "ext-start-1",
          name: "Queued Recipient",
          email: "queued@example.com",
        }),
      ],
    );

    const startResult = await client.query(
      `SELECT public.ui_start_tabular_import_run_v1($1::uuid, $2::jsonb) AS run`,
      [runId, JSON.stringify({ mode: "none" })],
    );

    expect(startResult.rows[0].run.id).toBe(runId);
    expect(startResult.rows[0].run.status).toBe("queued");
    expect(startResult.rows[0].run.task_id).toMatch(/^[0-9a-f-]{36}$/i);

    const taskResult = await client.query(
      `SELECT queue_key, status, idempotency_key
         FROM public.tasks
        WHERE id = $1::uuid`,
      [startResult.rows[0].run.task_id],
    );

    expect(taskResult.rows[0]).toEqual(
      expect.objectContaining({
        queue_key: "imports",
        status: "open",
        idempotency_key: `tabular_import_process:${runId}`,
      }),
    );

    const eventResult = await client.query(
      `SELECT actor_user_id, actor_system
         FROM public.task_events
        WHERE task_id = $1::uuid
        ORDER BY created_at ASC
        LIMIT 1`,
      [startResult.rows[0].run.task_id],
    );

    expect(eventResult.rows[0]).toEqual(
      expect.objectContaining({
        actor_user_id: userId,
        actor_system: "resource_import_studio",
      }),
    );

    await setServiceContext(client, userId, orgId);

    const claimResult = await client.query(
      `SELECT api.claim_tabular_import_task_v1($1::uuid, $2::text) AS claim`,
      [runId, "integration-worker"],
    );

    expect(claimResult.rows[0].claim).toEqual(
      expect.objectContaining({
        task_id: startResult.rows[0].run.task_id,
        run_id: runId,
        queue_key: "imports",
        worker_id: "integration-worker",
      }),
    );

    const processingRun = await client.query(
      `SELECT status, started_at
         FROM public.tabular_import_runs
        WHERE id = $1::uuid`,
      [runId],
    );

    expect(processingRun.rows[0]).toEqual(
      expect.objectContaining({
        status: "processing",
      }),
    );
    expect(processingRun.rows[0].started_at).not.toBeNull();
  });

  test("normalizes scoped ui_read_registry writes so import metadata survives merged reads", async () => {
    const orgId = randomUUID();
    const slug = `mapping-registry-org-${orgId.slice(0, 8)}`;
    const userId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Registry Normalization Org', $2)`,
      [orgId, slug],
    );
    await createUser(client, orgId, `mapping-registry-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const registryBefore = await client.query(
      `SELECT public.ui_read_registry_v1() AS registry`,
    );
    const globalRegistry = registryBefore.rows[0].registry;
    const recipientsResource = Array.isArray(globalRegistry?.resources)
      ? globalRegistry.resources.find((resource) => resource?.key === "recipients")
      : null;

    expect(recipientsResource).toBeTruthy();
    expect(recipientsResource.import?.enabled).toBe(true);

    const strippedRecipients = {
      ...recipientsResource,
      import: null,
      columns: Array.isArray(recipientsResource.columns)
        ? recipientsResource.columns.map((column) => ({ ...column, import: null }))
        : [],
    };

    const strippedRegistry = {
      ...globalRegistry,
      resources: Array.isArray(globalRegistry?.resources)
        ? globalRegistry.resources.map((resource) =>
            resource?.key === "recipients" ? strippedRecipients : resource,
          )
        : [],
    };

    const schemaVersionResult = await client.query(
      `SELECT version
         FROM public.schema_registry
        WHERE category = 'ui_read_registry'
          AND is_active = TRUE
        ORDER BY version DESC
        LIMIT 1`,
    );
    const schemaVersion = schemaVersionResult.rows[0]?.version ?? 1;

    await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT *
         FROM public.upsert_settings_value_v1(
           'ui_read_registry',
           'tenant',
           $1::uuid,
           $2::jsonb,
           $3::int,
           'integration test scoped ui_read_registry normalization'
         )`,
      [orgId, JSON.stringify(strippedRegistry), schemaVersion],
    ));

    const registryAfter = await client.query(
      `SELECT public.ui_read_registry_v1() AS registry`,
    );
    const scopedRecipients = Array.isArray(registryAfter.rows[0].registry?.resources)
      ? registryAfter.rows[0].registry.resources.find((resource) => resource?.key === "recipients")
      : null;

    expect(scopedRecipients).toBeTruthy();
    expect(scopedRecipients.import).toEqual(
      expect.objectContaining({
        enabled: true,
        allow_upsert: true,
        capability: "recipients.write",
      }),
    );
    expect(scopedRecipients.import.identity_columns).toEqual(
      expect.arrayContaining(["external_id"]),
    );
    const externalIdColumn = Array.isArray(scopedRecipients.columns)
      ? scopedRecipients.columns.find((column) => column?.key === "external_id")
      : null;
    expect(externalIdColumn.import).toEqual(
      expect.objectContaining({
        enabled: true,
        identity: true,
      }),
    );
  });

  test("restores canonical inline-node reference contracts on authenticated ui_read_registry reads", async () => {
    const orgId = randomUUID();
    const slug = `mapping-registry-related-org-${orgId.slice(0, 8)}`;
    const userId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Registry Related Graph Org', $2)`,
      [orgId, slug],
    );
    await createUser(client, orgId, `mapping-registry-related-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const registryResult = await client.query(`SELECT public.ui_read_registry_v1() AS registry`);
    const shipmentsResource = Array.isArray(registryResult.rows[0].registry?.resources)
      ? registryResult.rows[0].registry.resources.find((resource) => resource?.key === "shipments")
      : null;
    const recipientIdColumn = Array.isArray(shipmentsResource?.columns)
      ? shipmentsResource.columns.find((column) => column?.key === "recipient_id")
      : null;
    const destinationAddressColumn = Array.isArray(shipmentsResource?.columns)
      ? shipmentsResource.columns.find((column) => column?.key === "destination_address_id")
      : null;

    expect(shipmentsResource).toBeTruthy();
    expect(recipientIdColumn.import?.reference).toEqual(
      expect.objectContaining({
        resource: "recipients",
        allow_inline_node: true,
        inline_node_key: "recipient",
      }),
    );
    expect(destinationAddressColumn.import?.reference).toEqual(
      expect.objectContaining({
        resource: "addresses",
        allow_inline_node: true,
        inline_node_key: "destination_address",
      }),
    );
  });

  test("routes B04 zone and basket resources through api schema on authenticated ui_read_registry reads", async () => {
    const orgId = randomUUID();
    const slug = `mapping-registry-b04-org-${orgId.slice(0, 8)}`;
    const userId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Registry B04 Org', $2)`,
      [orgId, slug],
    );
    await createUser(client, orgId, `mapping-registry-b04-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const registryResult = await client.query(`SELECT public.ui_read_registry_v1() AS registry`);
    const resources = Array.isArray(registryResult.rows[0].registry?.resources)
      ? registryResult.rows[0].registry.resources
      : [];

    const relationByKey = new Map(
      resources
        .filter((resource) => resource?.key && resource?.relation)
        .map((resource) => [resource.key, resource.relation]),
    );

    expect(relationByKey.get("zones")).toBe("api.zones");
    expect(relationByKey.get("zone_districts")).toBe("api.zone_districts");
    expect(relationByKey.get("baskets")).toBe("api.baskets");
    expect(relationByKey.get("basket_items")).toBe("api.basket_items");
    expect(relationByKey.get("basket_transitions")).toBe("api.basket_transitions");
  });

  test("platform scope can resolve another tenant and prepare against it through scope_context", async () => {
    const homeOrgId = randomUUID();
    const targetOrgId = randomUUID();
    const platformUserId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug)
       VALUES
         ($1::uuid, 'Platform Home Org', $2),
         ($3::uuid, 'Platform Target Org', $4)`,
      [
        homeOrgId,
        `mapping-platform-home-${homeOrgId.slice(0, 8)}`,
        targetOrgId,
        `mapping-platform-target-${targetOrgId.slice(0, 8)}`,
      ],
    );
    const targetClient = await createClient(client, targetOrgId, "Platform Target Client", {
      slug: `mapping-platform-client-${targetOrgId.slice(0, 6)}`,
    });
    await createUser(client, homeOrgId, `mapping-platform-${platformUserId.slice(0, 8)}@example.com`, {
      id: platformUserId,
      userType: "super_admin",
      accessScopeType: "platform",
      accessScopeId: null,
      provisionRbac: false,
    });
    await setAuthContext(client, platformUserId, {
      organization_id: homeOrgId,
      scope_type: "platform",
      scope_id: null,
    });

    const scopeResult = await client.query(
      `SELECT public.ui_resolve_import_scope_context_v1($1::jsonb) AS scope_resolution`,
      [
        JSON.stringify({
          scope_context: {
            tenant: targetOrgId,
            client: targetClient.id,
          },
        }),
      ],
    );

    expect(scopeResult.rows[0].scope_resolution.organization_id).toBe(targetOrgId);
    expect(scopeResult.rows[0].scope_resolution.client_id).toBe(targetClient.id);

    const prepareResult = await client.query(
      `SELECT public.tabular_import_prepare_v1($1::jsonb) AS run`,
      [
        JSON.stringify({
          resource_key: "recipients",
          source_format: "csv",
          source_file_name: "recipients-platform-scope.csv",
          header_fingerprint: "email|external_id|name|phone_number|preferred_language",
          scope_context: {
            tenant: targetOrgId,
            client: targetClient.id,
          },
          headers: ["External Id", "Name", "Email", "Phone Number", "Preferred Language"],
          rules: [
            { source_column: "External Id", target_field: "external_id", enabled: true },
            { source_column: "Name", target_field: "name", enabled: true },
            { source_column: "Email", target_field: "email", enabled: true },
            { source_column: "Phone Number", target_field: "phone_number", enabled: true },
            { source_column: "Preferred Language", target_field: "preferred_language", enabled: true },
          ],
          rows: [
            {
              "External Id": "ext-platform-1",
              Name: "Platform Scoped Recipient",
              Email: "platform.scope@example.com",
              "Phone Number": "+12025550123",
              "Preferred Language": "ar",
            },
          ],
        }),
      ],
    );

    expect(prepareResult.rows[0].run.blocked_count).toBe(0);
    expect(prepareResult.rows[0].run.will_create).toBe(1);
    expect(prepareResult.rows[0].run.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "create",
          mapped_row: expect.objectContaining({
            client_id: targetClient.id,
            external_id: "ext-platform-1",
          }),
        }),
      ]),
    );
  });

  test("stages and executes related recipient and address nodes before creating the primary shipment", async () => {
    const orgId = randomUUID();
    const slug = `mapping-related-graph-org-${orgId.slice(0, 8)}`;
    const userId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Related Graph Org', $2)`,
      [orgId, slug],
    );
    const clientScope = await createClient(client, orgId, "Related Graph Client");
    const otherClientScope = await createClient(client, orgId, "Related Graph Other Client");
    const senderId = await createSender(client, clientScope.id, "Related Graph Sender");
    await client.query(
      `INSERT INTO public.addresses (
         id,
         organization_id,
         client_id,
         raw_input,
         normalized_line1,
         city,
         province,
         postal_code,
         country,
         validation_status
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         '742 Example Street',
         '742 Example Street',
         'Riyadh',
         'Riyadh',
         '11564',
         'SA',
         'pending'
       )`,
      [randomUUID(), orgId, otherClientScope.id],
    );
    await createUser(client, orgId, `mapping-related-graph-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const trackingNumber = `trk-related-${Date.now()}`;
    const prepareResult = await client.query(
      `SELECT public.tabular_import_prepare_v1($1::jsonb) AS run`,
      [
        JSON.stringify({
          resource_key: "shipments",
          source_format: "csv",
          source_file_name: "shipments-related-graph.csv",
          header_fingerprint:
            "address_line_1|city|country|postal_code|recipient_name|recipient_phone|tracking_number",
          scope_context: {
            tenant: orgId,
            client: clientScope.id,
            sender: senderId,
          },
          headers: [
            "Tracking Number",
            "Recipient Name",
            "Recipient Phone",
            "Address Line 1",
            "City",
            "Postal Code",
            "Country",
          ],
          rules: [
            { source_column: "Tracking Number", target_field: "tracking_number", enabled: true },
            { target_field: "service_type", value_mode: "fixed", fixed_value: "delivery", enabled: true },
            { target_field: "status", value_mode: "fixed", fixed_value: "created", enabled: true },
            { source_column: "Recipient Name", target_field: "recipient.name", enabled: true },
            { source_column: "Recipient Phone", target_field: "recipient.phone_number", enabled: true },
            { source_column: "Address Line 1", target_field: "destination_address.raw_input", enabled: true },
            {
              source_column: "Address Line 1",
              target_field: "destination_address.normalized_line1",
              enabled: true,
            },
            { source_column: "City", target_field: "destination_address.city", enabled: true },
            {
              target_field: "destination_address.province",
              value_mode: "fixed",
              fixed_value: "Riyadh",
              enabled: true,
            },
            {
              source_column: "Postal Code",
              target_field: "destination_address.postal_code",
              enabled: true,
            },
            { source_column: "Country", target_field: "destination_address.country", enabled: true },
            {
              target_field: "destination_address.validation_status",
              value_mode: "fixed",
              fixed_value: "pending",
              enabled: true,
            },
          ],
          rows: [
            {
              "Tracking Number": trackingNumber,
              "Recipient Name": "Import Graph Recipient",
              "Recipient Phone": "+12025550123",
              "Address Line 1": "742 Example Street",
              City: "Riyadh",
              "Postal Code": "11564",
              Country: "SA",
            },
          ],
        }),
      ],
    );

    expect(prepareResult.rows[0].run.blocked_count).toBe(0);
    expect(prepareResult.rows[0].run.related_nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          node_key: "recipient",
          will_create: 1,
        }),
        expect.objectContaining({
          node_key: "destination_address",
          will_create: 1,
        }),
      ]),
    );
    expect(prepareResult.rows[0].run.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "create",
          related_nodes: expect.arrayContaining([
            expect.objectContaining({
              node_key: "recipient",
              action: "create",
            }),
            expect.objectContaining({
              node_key: "destination_address",
              action: "create",
            }),
          ]),
        }),
      ]),
    );

    await setServiceContext(client, userId, orgId);

    const processResult = await client.query(
      `SELECT public.process_tabular_import_run_v1($1::uuid, $2::int) AS run`,
      [prepareResult.rows[0].run.run_id, 50],
    );

    expect(processResult.rows[0].run.status).toBe("completed");
    const expectedNextSteps = ["Review the imported records in the destination table or import history."];
    expect(processResult.rows[0].run.report.next_steps).toEqual(expectedNextSteps);
    expect(processResult.rows[0].run.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "create",
          execution_status: "succeeded",
          related_nodes: expect.arrayContaining([
            expect.objectContaining({
              node_key: "recipient",
              target_record_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
            }),
            expect.objectContaining({
              node_key: "destination_address",
              target_record_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
            }),
          ]),
        }),
      ]),
    );

    const executionEvidence = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT report_id, completed_at
         FROM public.tabular_import_runs
        WHERE id = $1::uuid`,
      [prepareResult.rows[0].run.run_id],
    ));

    expect(executionEvidence.rows[0].report_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(executionEvidence.rows[0].completed_at).not.toBeNull();

    const reportResult = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT artifact_type, operation_kind, primary_resource_type, primary_resource_id, status, next_steps
         FROM public.mapping_operation_reports
        WHERE id = $1::uuid`,
      [executionEvidence.rows[0].report_id],
    ));

    expect(reportResult.rows[0]).toEqual(
      expect.objectContaining({
        artifact_type: "tabular_import",
        operation_kind: "tabular_import_execution",
        primary_resource_type: "tabular_import_runs",
        primary_resource_id: prepareResult.rows[0].run.run_id,
        status: "succeeded",
        next_steps: expectedNextSteps,
      }),
    );

    const replay = await client.query(
      `SELECT public.process_tabular_import_run_v1($1::uuid, 50) AS run`,
      [prepareResult.rows[0].run.run_id],
    );
    expect(replay.rows[0].run.report.id).toBe(executionEvidence.rows[0].report_id);
    expect(replay.rows[0].run.report.next_steps).toEqual(expectedNextSteps);
    const reportCount = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT count(*)::int AS count FROM public.mapping_operation_reports
        WHERE primary_resource_type = 'tabular_import_runs' AND primary_resource_id = $1::uuid`,
      [prepareResult.rows[0].run.run_id],
    ));
    expect(reportCount.rows[0].count).toBe(1);

    const shipmentResult = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT tracking_number, recipient_id, destination_address_id, client_id, sender_id
         FROM public.shipments
        WHERE tracking_number = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [trackingNumber],
    ));

    expect(shipmentResult.rows).toHaveLength(1);
    expect(shipmentResult.rows[0]).toEqual(
      expect.objectContaining({
        tracking_number: trackingNumber,
        client_id: clientScope.id,
        sender_id: senderId,
        recipient_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        destination_address_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      }),
    );

    const recipientResult = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT name, phone_number, client_id, organization_id
         FROM public.recipients
        WHERE id = $1::uuid`,
      [shipmentResult.rows[0].recipient_id],
    ));

    expect(recipientResult.rows[0]).toEqual(
      expect.objectContaining({
        name: "Import Graph Recipient",
        phone_number: "+12025550123",
        client_id: clientScope.id,
        organization_id: orgId,
      }),
    );

    const addressResult = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT raw_input, normalized_line1, city, province, postal_code, country, validation_status, client_id, organization_id
         FROM public.addresses
        WHERE id = $1::uuid`,
      [shipmentResult.rows[0].destination_address_id],
    ));

    expect(addressResult.rows[0]).toEqual(
      expect.objectContaining({
        raw_input: "742 Example Street",
        normalized_line1: "742 Example Street",
        city: "Riyadh",
        province: "Riyadh",
        postal_code: "11564",
        country: "SA",
        validation_status: "pending",
        client_id: clientScope.id,
        organization_id: orgId,
      }),
    );
  });

  test("inherits primary fixed client and sender values into related-node payloads when tenant scope is broad", async () => {
    const orgId = randomUUID();
    const slug = `mapping-related-inherit-org-${orgId.slice(0, 8)}`;
    const userId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Related Inherit Org', $2)`,
      [orgId, slug],
    );
    const clientScope = await createClient(client, orgId, "Related Inherit Client");
    const senderId = await createSender(client, clientScope.id, "Related Inherit Sender");
    await createUser(client, orgId, `mapping-related-inherit-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const trackingNumber = `trk-related-inherit-${Date.now()}`;
    const prepareResult = await client.query(
      `SELECT public.tabular_import_prepare_v1($1::jsonb) AS run`,
      [
        JSON.stringify({
          resource_key: "shipments",
          source_format: "csv",
          source_file_name: "shipments-related-inherit.csv",
          header_fingerprint:
            "address_line_1|city|country|postal_code|recipient_name|recipient_phone|tracking_number",
          scope_context: {
            tenant: orgId,
          },
          headers: [
            "Tracking Number",
            "Recipient Name",
            "Recipient Phone",
            "Address Line 1",
            "City",
            "Postal Code",
            "Country",
          ],
          rules: [
            { source_column: "Tracking Number", target_field: "tracking_number", enabled: true },
            { target_field: "client_id", value_mode: "fixed", fixed_value: clientScope.id, enabled: true },
            { target_field: "sender_id", value_mode: "fixed", fixed_value: senderId, enabled: true },
            { target_field: "service_type", value_mode: "fixed", fixed_value: "delivery", enabled: true },
            { target_field: "status", value_mode: "fixed", fixed_value: "created", enabled: true },
            { source_column: "Recipient Name", target_field: "recipient.name", enabled: true },
            { source_column: "Recipient Phone", target_field: "recipient.phone_number", enabled: true },
            { source_column: "Address Line 1", target_field: "destination_address.raw_input", enabled: true },
            { source_column: "City", target_field: "destination_address.city", enabled: true },
            {
              target_field: "destination_address.province",
              value_mode: "fixed",
              fixed_value: "Riyadh",
              enabled: true,
            },
            {
              source_column: "Postal Code",
              target_field: "destination_address.postal_code",
              enabled: true,
            },
            { source_column: "Country", target_field: "destination_address.country", enabled: true },
            {
              target_field: "destination_address.validation_status",
              value_mode: "fixed",
              fixed_value: "pending",
              enabled: true,
            },
          ],
          rows: [
            {
              "Tracking Number": trackingNumber,
              "Recipient Name": "Inherited Scope Recipient",
              "Recipient Phone": "+12025550123",
              "Address Line 1": "801 Scope Street",
              City: "Riyadh",
              "Postal Code": "11564",
              Country: "SA",
            },
          ],
        }),
      ],
    );

    expect(prepareResult.rows[0].run.blocked_count).toBe(0);
    expect(prepareResult.rows[0].run.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          related_nodes: expect.arrayContaining([
            expect.objectContaining({
              node_key: "recipient",
              payload: expect.objectContaining({
                client_id: clientScope.id,
                organization_id: orgId,
              }),
            }),
            expect.objectContaining({
              node_key: "destination_address",
              payload: expect.objectContaining({
                client_id: clientScope.id,
                organization_id: orgId,
              }),
            }),
          ]),
        }),
      ]),
    );

    await setServiceContext(client, userId, orgId);

    const processResult = await client.query(
      `SELECT public.process_tabular_import_run_v1($1::uuid, $2::int) AS run`,
      [prepareResult.rows[0].run.run_id, 50],
    );

    expect(processResult.rows[0].run.status).toBe("completed");

    const shipmentResult = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT tracking_number, recipient_id, destination_address_id, client_id, sender_id
         FROM public.shipments
        WHERE tracking_number = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [trackingNumber],
    ));

    expect(shipmentResult.rows[0]).toEqual(
      expect.objectContaining({
        tracking_number: trackingNumber,
        client_id: clientScope.id,
        sender_id: senderId,
        recipient_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        destination_address_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      }),
    );

    const recipientResult = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT client_id, organization_id
         FROM public.recipients
        WHERE id = $1::uuid`,
      [shipmentResult.rows[0].recipient_id],
    ));
    expect(recipientResult.rows[0]).toEqual(
      expect.objectContaining({
        client_id: clientScope.id,
        organization_id: orgId,
      }),
    );

    const addressResult = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT client_id, organization_id
         FROM public.addresses
        WHERE id = $1::uuid`,
      [shipmentResult.rows[0].destination_address_id],
    ));
    expect(addressResult.rows[0]).toEqual(
      expect.objectContaining({
        client_id: clientScope.id,
        organization_id: orgId,
      }),
    );
  }, 30000);

  test("prepare blocks related-node imports when required child fields are missing", async () => {
    const orgId = randomUUID();
    const slug = `mapping-related-block-org-${orgId.slice(0, 8)}`;
    const userId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Related Block Org', $2)`,
      [orgId, slug],
    );
    const clientScope = await createClient(client, orgId, "Related Block Client");
    const senderId = await createSender(client, clientScope.id, "Related Block Sender");
    await createUser(client, orgId, `mapping-related-block-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const prepareResult = await client.query(
      `SELECT public.tabular_import_prepare_v1($1::jsonb) AS run`,
      [
        JSON.stringify({
          resource_key: "shipments",
          source_format: "csv",
          source_file_name: "shipments-related-missing-fields.csv",
          header_fingerprint:
            "address_line_1|city|country|postal_code|recipient_name|recipient_phone|tracking_number",
          scope_context: {
            tenant: orgId,
            client: clientScope.id,
            sender: senderId,
          },
          headers: [
            "Tracking Number",
            "Recipient Name",
            "Recipient Phone",
            "Address Line 1",
            "City",
            "Postal Code",
            "Country",
          ],
          rules: [
            { source_column: "Tracking Number", target_field: "tracking_number", enabled: true },
            { target_field: "service_type", value_mode: "fixed", fixed_value: "delivery", enabled: true },
            { target_field: "status", value_mode: "fixed", fixed_value: "created", enabled: true },
            { source_column: "Recipient Name", target_field: "recipient.name", enabled: true },
            { source_column: "Recipient Phone", target_field: "recipient.phone_number", enabled: true },
            {
              source_column: "Address Line 1",
              target_field: "destination_address.normalized_line1",
              enabled: true,
            },
            { source_column: "City", target_field: "destination_address.city", enabled: true },
            {
              source_column: "Postal Code",
              target_field: "destination_address.postal_code",
              enabled: true,
            },
            { source_column: "Country", target_field: "destination_address.country", enabled: true },
          ],
          rows: [
            {
              "Tracking Number": `trk-block-${Date.now()}`,
              "Recipient Name": "Blocked Graph Recipient",
              "Recipient Phone": "+12025550123",
              "Address Line 1": "555 Missing Fields Street",
              City: "Riyadh",
              "Postal Code": "11564",
              Country: "SA",
            },
          ],
        }),
      ],
    );

    expect(prepareResult.rows[0].run.blocked_count).toBe(1);
    expect(prepareResult.rows[0].run.blocking_diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "related_required_field_missing",
          fieldPath: "destination_address.raw_input",
        }),
        expect.objectContaining({
          code: "related_required_field_missing",
          fieldPath: "destination_address.province",
        }),
        expect.objectContaining({
          code: "related_required_field_missing",
          fieldPath: "destination_address.validation_status",
        }),
      ]),
    );

    await setServiceContext(client, userId, orgId);
    const processed = await client.query(
      `SELECT public.process_tabular_import_run_v1($1::uuid, 50) AS run`,
      [prepareResult.rows[0].run.run_id],
    );
    const run = processed.rows[0].run;
    expect(run.status).toBe("completed_with_errors");
    expect(run.report.next_steps).toEqual([
      "Download the annotated error export and correct the blocked or skipped rows before retrying.",
    ]);
    const persisted = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT next_steps FROM public.mapping_operation_reports WHERE id = $1::uuid`,
      [run.report_id],
    ));
    expect(persisted.rows[0].next_steps).toEqual(run.report.next_steps);
  });

  test("bulk shipment import routes through the workflow shipment-create contract", async () => {
    const orgId = randomUUID();
    const slug = `mapping-shipment-contract-org-${orgId.slice(0, 8)}`;
    const userId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Shipment Contract Org', $2)`,
      [orgId, slug],
    );
    const clientScope = await createClient(client, orgId, "Shipment Contract Client");
    const senderId = await createSender(client, clientScope.id, "Shipment Contract Sender");
    await createUser(client, orgId, `mapping-shipment-contract-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const trackingNumber = `ship-contract-${orgId.slice(0, 8)}-001`;
    const shipmentPayload = {
      organization_id: orgId,
      client_id: clientScope.id,
      sender_id: senderId,
      tracking_number: trackingNumber,
      client_reference_number: `contract-ref-${orgId.slice(0, 8)}`,
      carrier_reference_number: `carrier-ref-${orgId.slice(0, 8)}`,
      service_type: "delivery",
      status: "created",
      box_count: 1,
    };

    await setServiceContext(client, userId, orgId);
    const firstWrite = await client.query(
      `SELECT public.tabular_import_write_row_v1('public.shipments', 'id', $1::jsonb, NULL) AS shipment`,
      [JSON.stringify(shipmentPayload)],
    );

    const firstShipment = firstWrite.rows[0].shipment;
    expect(firstShipment.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(firstShipment.client_id).toBe(clientScope.id);
    expect(firstShipment.organization_id).toBe(orgId);
    expect(firstShipment.sender_id).toBe(senderId);
    expect(firstShipment.tracking_number).toBe(trackingNumber);
    expect(firstShipment.metadata).toEqual(
      expect.objectContaining({
        created_by: "workflow",
        workflow_run_id: expect.any(String),
      }),
    );

    await setServiceContext(client, userId, orgId);
    const secondWrite = await client.query(
      `SELECT public.tabular_import_write_row_v1('public.shipments', 'id', $1::jsonb, NULL) AS shipment`,
      [JSON.stringify(shipmentPayload)],
    );

    expect(secondWrite.rows[0].shipment.id).toBe(firstShipment.id);
    expect(secondWrite.rows[0].shipment.metadata.workflow_run_id).toBe(firstShipment.metadata.workflow_run_id);

    const shipmentCount = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT count(*)::int AS count
         FROM public.shipments
        WHERE organization_id = $1::uuid
          AND client_id = $2::uuid
          AND tracking_number = $3`,
      [orgId, clientScope.id, trackingNumber],
    ));
    expect(shipmentCount.rows[0].count).toBe(1);

    const decisionLog = await fetchDecisionLog(client, {
      resourceType: "shipment",
      resourceId: firstShipment.id,
      decisionCategory: "shipment_create",
      limit: 5,
    });

    expect(decisionLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          performed_by_system: "workflow_handlers.execute_shipment_create_v1",
          decision_outcome: "reused_existing_shipment",
        }),
      ]),
    );
  }, 30000);

  test("clients resolve and execute through the generic create-only tabular import flow", async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    const clientSlug = `imported-client-${orgId.slice(0, 8)}`;
    await client.query(
      `INSERT INTO public.organizations (id, name, slug)
       VALUES ($1::uuid, 'Client Import Org', $2)`,
      [orgId, `client-import-org-${orgId.slice(0, 8)}`],
    );
    await createUser(client, orgId, `client-import-${userId.slice(0, 8)}@example.com`, {
      id: userId,
      userType: "ops_admin",
    });
    await setAuthContext(client, userId, {
      organization_id: orgId,
      scope_type: "tenant",
      scope_id: orgId,
    });

    const resourceResult = await client.query(
      `SELECT public.tabular_import_resolve_resource_v1('clients') AS resource`,
    );
    const resource = resourceResult.rows[0].resource;
    const requiredFields = resource.columns
      .filter((column) => column.import?.enabled && column.import?.required)
      .map((column) => column.key)
      .sort();
    expect(resource).toEqual(expect.objectContaining({
      key: "clients",
      relation: "public.clients",
      capability_write: "clients.write",
    }));
    expect(resource.import).toEqual(expect.objectContaining({
      enabled: true,
      capability: "clients.write",
      default_write_mode: "create",
      allow_upsert: false,
      accepted_formats: expect.arrayContaining(["csv", "xls", "xlsx"]),
    }));
    expect(requiredFields).toEqual(["name", "slug"]);

    const prepareResult = await client.query(
      `SELECT public.tabular_import_prepare_v1($1::jsonb) AS run`,
      [JSON.stringify({
        resource_key: "clients",
        source_format: "csv",
        source_file_name: "clients.csv",
        header_fingerprint: "name|slug",
        scope_context: { tenant: orgId },
        headers: ["Name", "Slug"],
        rules: [
          { source_column: "Name", target_field: "name", enabled: true },
          { source_column: "Slug", target_field: "slug", enabled: true },
        ],
        rows: [
          { Name: "Imported Client", Slug: clientSlug },
          { Name: "Blocked Client", Slug: "" },
        ],
      })],
    );
    expect(prepareResult.rows[0].run).toEqual(expect.objectContaining({
      blocked_count: 1,
      will_create: 1,
      write_mode: "create",
    }));

    await setServiceContext(client, userId, orgId);
    const processResult = await client.query(
      `SELECT public.process_tabular_import_run_v1($1::uuid, 50) AS run`,
      [prepareResult.rows[0].run.run_id],
    );
    expect(processResult.rows[0].run).toEqual(expect.objectContaining({
      status: "completed_with_errors",
      created_count: 1,
      failed_count: 0,
      blocked_count: 1,
    }));
    expect(processResult.rows[0].run.report.next_steps).toEqual([
      "Download the annotated error export and correct the blocked or skipped rows before retrying.",
      "Review the imported records in the destination table or import history.",
    ]);

    const report = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT status, next_steps FROM public.mapping_operation_reports WHERE id = $1::uuid`,
      [processResult.rows[0].run.report_id],
    ));
    expect(report.rows[0]).toEqual({
      status: "failed",
      next_steps: [
        "Download the annotated error export and correct the blocked or skipped rows before retrying.",
        "Review the imported records in the destination table or import history.",
      ],
    });

    const created = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT organization_id, name, slug
         FROM public.clients
        WHERE slug = $1`,
      [clientSlug],
    ));
    expect(created.rows).toEqual([{
      organization_id: orgId,
      name: "Imported Client",
      slug: clientSlug,
    }]);
  }, 30000);
});
