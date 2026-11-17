const { Pool } = require("pg");
const { loadEnv } = require("../../../scripts/utils/load-env");

loadEnv();

const {
  createOrganization,
  createClient,
  createSender,
  createUser,
  applySetting,
  setAuthContext,
  setFixtureAdminContext,
  withFixtureAdminContext,
  cleanupAutoOnboardingArtifacts,
} = require("../helpers/tenant-utils");

describe("ui_create_shipment_v1", () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  let client;
  let organizationId;
  let clientId;
  let senderId;
  let userId;
  let otherOrganizationId;
  let otherClientId;
  let otherSenderId;
  let otherUserId;
  let limitedUserId;
  let trackingPolicyVersionId;
  let serviceLevelId;
  let serviceOfferingId;

  beforeAll(async () => {
    const admin = await pool.connect();
    try {
      const organization = await createOrganization(admin, "UI Shipment Create Org", {
        slug: `ui-shipment-create-org-${Date.now()}`,
      });
      organizationId = organization.id;

      const clientRecord = await createClient(
        admin,
        organizationId,
        "UI Shipment Create Client",
        {
          slug: `ui-shipment-create-client-${Date.now()}`,
        }
      );
      clientId = clientRecord.id;
      senderId = await createSender(admin, clientId, "UI Shipment Create Sender");
      userId = await createUser(admin, organizationId, `ui-create-${Date.now()}@demo.local`, {
        accessScopeType: "tenant",
        userType: "ops_admin",
      });
      const otherOrganization = await createOrganization(admin, "UI Shipment Timeline Other Org", {
        slug: `ui-shipment-timeline-other-org-${Date.now()}`,
      });
      otherOrganizationId = otherOrganization.id;
      const otherClientRecord = await createClient(
        admin,
        otherOrganizationId,
        "UI Shipment Timeline Other Client",
        {
          slug: `ui-shipment-timeline-other-client-${Date.now()}`,
        }
      );
      otherClientId = otherClientRecord.id;
      otherSenderId = await createSender(
        admin,
        otherClientId,
        "UI Shipment Timeline Other Sender"
      );
      otherUserId = await createUser(
        admin,
        otherOrganizationId,
        `ui-create-other-${Date.now()}@demo.local`,
        {
          accessScopeType: "tenant",
          userType: "ops_admin",
        }
      );
      limitedUserId = await createUser(
        admin,
        organizationId,
        `ui-create-limited-${Date.now()}@demo.local`,
        {
          accessScopeType: "tenant",
          userType: "sender_user",
        }
      );

      trackingPolicyVersionId = await applySetting(admin, {
        category: "tracking_policy",
        scopeType: "client",
        scopeId: clientId,
        value: {
          version: 1,
          unique_scope: "client",
          alphabet: "BASE36",
          checksum: "iso7064_mod_37_36",
          prefix: { value: "UI", separator: "", max_len: 4 },
          sequence: { scope: "client", strategy: "pg_sequence", cache: 100, start: 1 },
          tokens: [{ type: "prefix" }, { type: "seq", len: 6 }, { type: "chk" }],
          sync_generate: true,
        },
        version: 1,
        schemaVersion: 1,
        approvedAt: new Date().toISOString(),
      });

      const { rows: levelRows } = await admin.query(
        `INSERT INTO public.service_levels (organization_id, key, name, metadata)
         VALUES ($1::uuid, 'standard', 'Integration standard', '{}'::jsonb)
         RETURNING id`,
        [organizationId]
      );
      serviceLevelId = levelRows[0].id;
      const { rows: branchRows } = await admin.query(
        `INSERT INTO public.branches (organization_id, code, name, timezone, is_active)
         VALUES ($1::uuid, $2::text, 'UI create branch', 'Asia/Riyadh', TRUE)
         RETURNING id`,
      [organizationId, `ui${Date.now().toString().slice(-8)}`]
      );
      const { rows: offeringRows } = await admin.query(
        `INSERT INTO public.service_offerings (
           service_level_id, branch_id, priority, is_active, metadata
         ) VALUES (
           $1::uuid, $2::uuid, 10, TRUE,
           jsonb_build_object('display', jsonb_build_object('name', 'Integration offering'))
         ) RETURNING id`,
        [serviceLevelId, branchRows[0].id]
      );
      serviceOfferingId = offeringRows[0].id;
    } finally {
      admin.release();
    }
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    await setAuthContext(client, userId);
  });

  afterEach(async () => {
    if (client) {
      await client.query("ROLLBACK");
      client.release();
      client = null;
    }
  });

  afterAll(async () => {
    const admin = await pool.connect();
    try {
      await admin.query(
        "DELETE FROM public.rbac_user_role_assignments WHERE organization_id = $1::uuid",
        [organizationId]
      );
      await admin.query(
        "DELETE FROM public.rbac_user_role_assignments WHERE organization_id = $1::uuid",
        [otherOrganizationId]
      );
      await admin.query("DELETE FROM public.users WHERE id = $1::uuid", [userId]);
      await admin.query("DELETE FROM public.users WHERE id = $1::uuid", [otherUserId]);
      await admin.query("DELETE FROM public.users WHERE id = $1::uuid", [limitedUserId]);
      await admin.query(
        "DELETE FROM public.settings WHERE category = 'tracking_policy' AND scope_type = 'client' AND scope_id = $1::uuid",
        [clientId]
      );
      if (trackingPolicyVersionId) {
        await admin.query("DELETE FROM public.settings_versions WHERE id = $1::uuid", [
          trackingPolicyVersionId,
        ]);
      }
      await admin.query("DELETE FROM public.decision_log WHERE organization_id = $1::uuid", [
        organizationId,
      ]);
      await admin.query("DELETE FROM public.decision_log WHERE organization_id = $1::uuid", [
        otherOrganizationId,
      ]);
      await admin.query("DELETE FROM public.settings_resolution_log WHERE organization_id = $1::uuid", [
        organizationId,
      ]);
      await admin.query("DELETE FROM public.settings_resolution_log WHERE organization_id = $1::uuid", [
        otherOrganizationId,
      ]);
      await admin.query("DELETE FROM public.senders WHERE client_id = $1::uuid", [otherClientId]);
      await admin.query("DELETE FROM public.clients WHERE id = $1::uuid", [otherClientId]);
      await admin.query("DELETE FROM public.senders WHERE client_id = $1::uuid", [clientId]);
      await admin.query("DELETE FROM public.clients WHERE id = $1::uuid", [clientId]);
      await cleanupAutoOnboardingArtifacts(admin, organizationId);
      await cleanupAutoOnboardingArtifacts(admin, otherOrganizationId);
      await admin.query("DELETE FROM public.organizations WHERE id = $1::uuid", [organizationId]);
      await admin.query("DELETE FROM public.organizations WHERE id = $1::uuid", [otherOrganizationId]);
    } finally {
      admin.release();
      await pool.end();
    }
  });

  async function insertRecipient({ organizationId, clientId, name, phoneNumber }) {
    const { rows } = await client.query(
      `
        INSERT INTO recipients (
          organization_id,
          client_id,
          name,
          phone_number,
          phone_number_normalized,
          preferred_language
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::text,
          $4::text,
          public.normalize_phone_number($4::text),
          'en'
        )
        RETURNING id
      `,
      [organizationId, clientId, name, phoneNumber]
    );
    return rows[0]?.id ?? null;
  }

  async function listShipmentsByIdentifier(identifier) {
    const { rows } = await client.query(
      `
        SELECT public.ui_list_resource_v1(
          'shipments',
          jsonb_build_object('identifier', $1::text),
          25,
          0,
          NULL
        ) AS payload
      `,
      [identifier]
    );
    return rows[0]?.payload ?? {};
  }

  async function shipmentMetricsByIdentifier(identifier) {
    const { rows } = await client.query(
      `
        SELECT public.ui_resource_metrics_v1(
          'shipments',
          jsonb_build_object('identifier', $1::text),
          ARRAY['box_count']
        ) AS payload
      `,
      [identifier]
    );
    return rows[0]?.payload ?? {};
  }

  test("creates a shipment through the reserve/create workflow with audit correlation", async () => {
    const trackingNumber = `UI-MANUAL-${Date.now()}`;
    const clientReferenceNumber = `UI-REF-${Date.now()}`;
    const { rows } = await client.query(
      `
        SELECT public.ui_create_shipment_v1(
          $1::uuid,
          $2::uuid,
          $3::text,
          $4::text,
          $5::text,
          NULL,
          $6::text,
          $7::jsonb
        ) AS result
      `,
      [
        clientId,
        senderId,
        "delivery",
        trackingNumber,
        clientReferenceNumber,
        "pending",
        JSON.stringify({ source: "integration.ui_create_shipment" }),
      ]
    );

    const result = rows[0]?.result ?? {};
    expect(result.status).toBe("shipment_created");
    expect(result.shipment_id).toBeTruthy();
    expect(result.workflow_run_id).toBeTruthy();
    expect(result.correlation_id).toBeTruthy();
    expect(result.tracking_number).toBe(trackingNumber);

    const { rows: workflowRows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `
        SELECT workflow_status, triggered_by_request_id, context
        FROM workflow_runs
        WHERE id = $1::uuid
      `,
      [result.workflow_run_id]
    ));
    expect(workflowRows[0]?.workflow_status).toBe("completed");
    expect(workflowRows[0]?.triggered_by_request_id).toBe(result.correlation_id);
    expect(workflowRows[0]?.context?.shipment?.id).toBe(result.shipment_id);

    const { rows: traceRows } = await client.query(
      `
        SELECT public.ui_get_trace_v1($1::uuid) AS trace
      `,
      [result.correlation_id]
    );
    const trace = traceRows[0]?.trace ?? {};
    const traceWorkflowRuns = Array.isArray(trace.workflow_runs) ? trace.workflow_runs : [];
    const traceEvents = Array.isArray(trace.observability_events) ? trace.observability_events : [];
    const shipmentCreateTraceEvent = traceEvents.find(
      (event) =>
        event?.event_type === "workflow"
        && event?.metadata?.decision_inputs?.handler_key === "shipment_create"
    );
    expect(trace.correlation_id).toBe(result.correlation_id);
    expect(
      traceWorkflowRuns.some((run) => run?.id === result.workflow_run_id)
    ).toBe(true);
    expect(
      traceWorkflowRuns.some(
        (run) => run?.triggered_by_request_id === result.correlation_id
      )
    ).toBe(true);
    expect(shipmentCreateTraceEvent).toBeTruthy();

    const { rows: stepRows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `
        SELECT step_status, decision_log_id, operation_result
        FROM workflow_run_steps
        WHERE workflow_run_id = $1::uuid
          AND handler_key = 'shipment_create'
        ORDER BY sequence_order
        LIMIT 1
      `,
      [result.workflow_run_id]
    ));
    expect(stepRows[0]?.step_status).toBe("completed");
    expect(stepRows[0]?.decision_log_id).toBeTruthy();
    expect(stepRows[0]?.operation_result?.shipment_id).toBe(result.shipment_id);

    // Read the workflow decision inside the same transaction so the spec does
    // not depend on cross-connection visibility before the test commits.
    await setFixtureAdminContext(client);
    const { rows: decisionRows } = await client.query(
      `
        SELECT decision_category, decision_inputs->>'handler_key' AS handler_key
        FROM decision_log
        WHERE id = $1::uuid
      `,
      [stepRows[0].decision_log_id]
    );
    expect(decisionRows[0]?.decision_category).toBe("workflow");
    expect(decisionRows[0]?.handler_key).toBe("shipment_create");
  });

  async function reportFailedAddressWorkflow(result) {
    if (result.workflow_status !== 'failed' || !result.workflow_run_id) return;
    // Read before this test rolls back. Never emit raw errors, payloads, or context.
    const { rows } = await withFixtureAdminContext(client, db => db.query(`
      SELECT CASE WHEN handler_key ~ '^[a-z][a-z0-9_]{0,79}$'
        THEN handler_key ELSE 'unclassified_handler' END AS handler,
        step_status,
        CASE WHEN operation_result->>'error_code' ~ '^[0-9A-Z]{5}$'
          THEN operation_result->>'error_code' ELSE NULL END AS error_code,
        CASE
          WHEN last_error ILIKE '%permission denied%' THEN 'permission_denied'
          WHEN last_error ILIKE '%lookup%' THEN 'lookup_contract'
          WHEN last_error ILIKE '%does not exist%' THEN 'missing_sql_object'
          WHEN last_error ILIKE '%not-null%' OR last_error ILIKE '%null value%' THEN 'required_value'
          WHEN last_error ILIKE '%foreign key%' THEN 'foreign_key'
          WHEN last_error ILIKE '%check constraint%' THEN 'check_constraint'
          WHEN last_error ILIKE '%invalid input syntax%' THEN 'invalid_sql_value'
          ELSE 'unclassified_workflow_failure'
        END AS reason
      FROM public.workflow_run_steps WHERE workflow_run_id=$1::uuid AND step_status='failed'
      ORDER BY sequence_order LIMIT 8`, [result.workflow_run_id]));
    console.info('[address-create-failure]', JSON.stringify(rows));
  }

  test("API destination capture persists normalized address and verifies duplicate readback", async () => {
    const tracking = "F54-" + Date.now();
    const address = { line1: "King Road", city: "Riyadh", country: "SA",
      shortNationalAddress: "rrrd2929", coordinates: { latitude: 24.7136, longitude: 46.6753 } };
    const call = () => client.query(
      "SELECT api.ui_create_shipment_v1($1::uuid,$2::uuid,'delivery',$3::text,NULL,NULL,'pending',$4::jsonb) AS result",
      [clientId, senderId, tracking, JSON.stringify({ service_offering_id: serviceOfferingId, destination_address: address })]
    );
    const result = (await call()).rows[0].result;
    await reportFailedAddressWorkflow(result);
    expect(result.workflow_status).toBe("completed");
    expect(result.destination_address_capture).toMatchObject({
      status: "verified", sa_short_code: "RRRD2929",
      coordinates: { latitude: 24.7136, longitude: 46.6753 },
    });
    const rows = (await client.query(
      "SELECT a.sa_short_code, a.province, ST_Y(a.coordinates::geometry) AS lat, ST_X(a.coordinates::geometry) AS lng FROM public.shipments s JOIN public.addresses a ON a.id=s.destination_address_id WHERE s.id=$1::uuid",
      [result.shipment_id]
    )).rows;
    expect(rows[0]).toEqual({ sa_short_code: "RRRD2929", province: "Riyadh", lat: 24.7136, lng: 46.6753 });
    const replay = (await call()).rows[0].result;
    expect(replay.shipment_id).toBe(result.shipment_id);
    expect(replay.destination_address_capture).toEqual(result.destination_address_capture);
  });

  test.each([
    [{ province: "Explicit province", region: "Other region" }, "Explicit province"],
    [{ region: "Explicit region" }, "Explicit region"],
    [{ province: " ", region: " " }, "Riyadh"],
  ])("destination capture retains province/region precedence %#", async (fields, expected) => {
    const address = { line1: "King Road", city: "Riyadh", country: "SA", ...fields };
    const result = (await client.query(
      "SELECT api.ui_create_shipment_v1($1::uuid,$2::uuid,'delivery',$3::text,NULL,NULL,'pending',$4::jsonb) AS result",
      [clientId, senderId, "PROVINCE-" + Date.now(), JSON.stringify({ service_offering_id: serviceOfferingId, destination_address: address })]
    )).rows[0].result;
    await reportFailedAddressWorkflow(result);
    expect(result.workflow_status).toBe("completed");
    const { rows } = await client.query(
      "SELECT a.province FROM public.shipments s JOIN public.addresses a ON a.id=s.destination_address_id AND a.client_id=s.client_id WHERE s.id=$1::uuid",
      [result.shipment_id]
    );
    expect(rows).toEqual([{ province: expected }]);
  });

  test.each([
    null, [], "invalid", {}, { latitude: 24 }, { longitude: 46 },
    { latitude: "NaN", longitude: 46 }, { latitude: "Infinity", longitude: 46 },
    { latitude: 91, longitude: 46 }, { latitude: 24, longitude: 181 },
  ])("rejects invalid destination capture %# before workflow creation", async (address) => {
    await expect(client.query(
      "SELECT api.ui_create_shipment_v1($1::uuid,$2::uuid,'delivery',NULL,NULL,NULL,'pending',$3::jsonb)",
      [clientId, senderId, JSON.stringify({ service_offering_id: serviceOfferingId, destination_address: address && !Array.isArray(address) && typeof address === "object" && Object.keys(address).length > 0 ? { line1: "King Road", city: "Riyadh", ...address } : address })]
    )).rejects.toThrow(/destination_address|address coordinates/);
  });

  test("destination capture cannot bypass create client scope", async () => {
    await expect(client.query(
      "SELECT api.ui_create_shipment_v1($1::uuid,$2::uuid,'delivery',NULL,NULL,NULL,'pending',$3::jsonb)",
      [otherClientId, otherSenderId, JSON.stringify({ service_offering_id: serviceOfferingId, destination_address: {
        line1: "Foreign", city: "Riyadh", country: "SA", sa_short_code: "RRRD2929",
      } })]
    )).rejects.toThrow();
  });

  test("private capture proof keeps pending unverified and binds fallback to current destination", async () => {
    const address = { line1: "King Road", city: "Riyadh", country: "SA",
      sa_short_code: "RRRD2929", latitude: 24.7136, longitude: 46.6753 };
    const result = (await client.query(
      "SELECT api.ui_create_shipment_v1($1::uuid,$2::uuid,'delivery',$3::text,NULL,NULL,'pending',$4::jsonb) AS result",
      [clientId, senderId, "F54-PROOF-" + Date.now(), JSON.stringify({ service_offering_id: serviceOfferingId, destination_address: address })]
    )).rows[0].result;
    await reportFailedAddressWorkflow(result);
    const addressId = result.destination_address_capture.address_id;
    const other = (await client.query(
      "SELECT api.ui_create_shipment_v1($1::uuid,$2::uuid,'delivery',$3::text,NULL,NULL,'pending',$4::jsonb) AS result",
      [clientId, senderId, "F54-OTHER-" + Date.now(), JSON.stringify({ service_offering_id: serviceOfferingId, destination_address: address })]
    )).rows[0].result;
    await withFixtureAdminContext(client, async () => {
    const proof = async (completed, expected = address) => (await client.query(
      "SELECT public.shipment_destination_capture_result_v1($1::uuid,$2::jsonb,$3::boolean) AS proof",
      [result.shipment_id, JSON.stringify(expected), completed]
    )).rows[0].proof;
    expect(await proof(false)).toEqual({ status: "pending" });
    expect(await proof(true)).toMatchObject({ status: "verified" });
    await client.query(
      "INSERT INTO public.geocodes(address_id,client_id,provider_name,coordinates,is_primary,geocoded_at) VALUES($1::uuid,$2::uuid,'fixture',ST_SetSRID(ST_MakePoint(46.6753,24.7136),4326)::geography,TRUE,now())",
      [addressId, clientId]
    );
    await client.query("UPDATE public.addresses SET coordinates=NULL WHERE id=$1::uuid", [addressId]);
    expect(await proof(true)).toMatchObject({ status: "verified", coordinates: { latitude: 24.7136, longitude: 46.6753 } });
    await client.query("UPDATE public.addresses SET coordinates=ST_SetSRID(ST_MakePoint(40,20),4326)::geography WHERE id=$1::uuid", [addressId]);
    await client.query("SAVEPOINT f54_wrong_address_coordinates");
    await expect(proof(true)).rejects.toThrow(/coordinates readback mismatch/);
    await client.query("ROLLBACK TO SAVEPOINT f54_wrong_address_coordinates");
    await client.query("UPDATE public.addresses SET coordinates=NULL WHERE id=$1::uuid", [addressId]);
    await client.query("UPDATE public.geocodes SET is_primary=FALSE WHERE address_id=$1::uuid", [addressId]);
    await client.query("SAVEPOINT f54_nonprimary");
    await expect(proof(true)).rejects.toThrow(/coordinates readback mismatch/);
    await client.query("ROLLBACK TO SAVEPOINT f54_nonprimary");
    await client.query("UPDATE public.geocodes SET is_primary=TRUE, expires_at=now()-interval '1 second' WHERE address_id=$1::uuid", [addressId]);
    await client.query("SAVEPOINT f54_expired");
    await expect(proof(true)).rejects.toThrow(/coordinates readback mismatch/);
    await client.query("ROLLBACK TO SAVEPOINT f54_expired");
    await client.query("UPDATE public.geocodes SET address_id=$2::uuid,is_primary=TRUE,expires_at=NULL WHERE address_id=$1::uuid",
      [addressId, other.destination_address_capture.address_id]);
    await client.query("SAVEPOINT f54_wrong_destination");
    await expect(proof(true)).rejects.toThrow(/coordinates readback mismatch/);
    await client.query("ROLLBACK TO SAVEPOINT f54_wrong_destination");
    await client.query("SAVEPOINT f54_wrong_code");
    await expect(proof(true, { sa_short_code: "ABCD1234" })).rejects.toThrow(/short address readback mismatch/);
    await client.query("ROLLBACK TO SAVEPOINT f54_wrong_code");
    });
  });

  test("capture proof stays private while original create grants remain", async () => {
    const { rows } = await client.query(`SELECT
      has_function_privilege('authenticated','public.ui_create_shipment_v1(uuid,uuid,text,text,text,text,text,jsonb)','EXECUTE') AS public_create,
      has_function_privilege('authenticated','api.ui_create_shipment_v1(uuid,uuid,text,text,text,text,text,jsonb)','EXECUTE') AS api_create,
      has_function_privilege('authenticated','public.shipment_destination_capture_result_v1(uuid,jsonb,boolean)','EXECUTE') AS proof_auth,
      has_function_privilege('anon','public.shipment_destination_capture_result_v1(uuid,jsonb,boolean)','EXECUTE') AS proof_anon,
      has_function_privilege('service_role','public.shipment_destination_capture_result_v1(uuid,jsonb,boolean)','EXECUTE') AS proof_service`);
    expect(rows[0]).toEqual({ public_create: true, api_create: true, proof_auth: false, proof_anon: false, proof_service: false });
  });

  test("validates and derives canonical service-offering lineage during workflow create", async () => {
    const trackingNumber = `UI-CATALOG-${Date.now()}`;
    const { rows } = await client.query(
      `SELECT api.ui_create_shipment_v1(
         $1::uuid, $2::uuid, 'delivery', $3::text, NULL, NULL, 'pending',
         jsonb_build_object('service_offering_id', $4::uuid)
       ) AS result`,
      [clientId, senderId, trackingNumber, serviceOfferingId]
    );
    const result = rows[0]?.result ?? {};
    expect(result.status).toBe("shipment_created");

    const { rows: shipmentRows } = await client.query(
      `SELECT service_level, branch_id, metadata
         FROM public.shipments
        WHERE id = $1::uuid AND client_id = $2::uuid`,
      [result.shipment_id, clientId]
    );
    expect(shipmentRows[0]?.service_level).toBe("standard");
    expect(shipmentRows[0]?.branch_id).toBeTruthy();
    expect(shipmentRows[0]?.metadata?.service_offering_id).toBe(serviceOfferingId);
    expect(shipmentRows[0]?.metadata?.service_level_id).toBe(serviceLevelId);
  });

  test("queues shipment-created SMS notification with tracking link and provenance", async () => {
    await setFixtureAdminContext(client);
    const recipientId = await insertRecipient({
      organizationId,
      clientId,
      name: "Shipment Notification Recipient",
      phoneNumber: "+966 55 123 4567",
    });
    await setAuthContext(client, userId);
    const trackingNumber = `UI-COMMS-${Date.now()}`;
    const { rows } = await client.query(
      `
        SELECT public.ui_create_shipment_v1(
          $1::uuid,
          $2::uuid,
          $3::text,
          $4::text,
          NULL,
          NULL,
          $5::text,
          $6::jsonb
        ) AS result
      `,
      [
        clientId,
        senderId,
        "delivery",
        trackingNumber,
        "pending",
        JSON.stringify({
          source: "integration.ui_create_shipment.comms",
          recipient_id: recipientId,
        }),
      ]
    );

    const result = rows[0]?.result ?? {};
    expect(result.status).toBe("shipment_created");
    expect(result.shipment_id).toBeTruthy();
    expect(result.workflow_run_id).toBeTruthy();

    await setFixtureAdminContext(client);

    const { rows: shipmentRows } = await client.query(
      `
        SELECT recipient_id, tracking_number
        FROM public.shipments
        WHERE id = $1::uuid
      `,
      [result.shipment_id]
    );
    expect(shipmentRows[0]?.recipient_id).toBe(recipientId);
    expect(shipmentRows[0]?.tracking_number).toBe(trackingNumber);

    const { rows: stepRows } = await client.query(
      `
        SELECT sequence_order, handler_key, step_status, operation_result
        FROM public.workflow_run_steps
        WHERE workflow_run_id = $1::uuid
        ORDER BY sequence_order
      `,
      [result.workflow_run_id]
    );
    const notificationStep = stepRows.find((row) => row.handler_key === "shipment_created_notification");
    expect(notificationStep?.sequence_order).toBe(2);
    expect(notificationStep?.step_status).toBe("completed");
    expect(notificationStep?.operation_result?.queued).toBe(true);

    const { rows: outboundRows } = await client.query(
      `
        SELECT call_type, target_type, target_id, shipment_id, url, body, context
        FROM public.outbound_calls
        WHERE shipment_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [result.shipment_id]
    );
    expect(outboundRows[0]?.call_type).toBe("comms_sms");
    expect(outboundRows[0]?.target_type).toBe("recipient");
    expect(outboundRows[0]?.target_id).toBe(recipientId);
    expect(outboundRows[0]?.shipment_id).toBe(result.shipment_id);
    expect(outboundRows[0]?.url).toBe("comms://sms");
    expect(outboundRows[0]?.body?.message).toContain(trackingNumber);
    expect(outboundRows[0]?.body?.tracking_link).toContain("https://nzxmhryhtqlzoshjkyozkpup.example.invalid/track/");
    expect(outboundRows[0]?.context?.source).toBe("shipment_created_notification");

    const { rows: decisionRows } = await client.query(
      `
        SELECT decision_category, decision_point, decision_outcome, settings_resolution_id
        FROM public.decision_log
        WHERE resource_type = 'shipment'
          AND resource_id = $1::uuid
          AND decision_category = 'outbound_call'
        ORDER BY timestamp DESC
        LIMIT 1
      `,
      [result.shipment_id]
    );
    expect(decisionRows[0]?.decision_category).toBe("outbound_call");
    expect(decisionRows[0]?.decision_point).toBe("shipment_created_notification");
    expect(decisionRows[0]?.decision_outcome).toBe("queued");
    expect(decisionRows[0]?.settings_resolution_id).toBeTruthy();

    const { rows: settingsRows } = await client.query(
      `
        SELECT category, winning_scope_type, winning_scope_id
        FROM public.settings_resolution_log
        WHERE category = 'shipment_created_notification_policy'
          AND organization_id = $1::uuid
        ORDER BY resolved_at DESC
        LIMIT 1
      `,
      [organizationId]
    );
    expect(settingsRows[0]?.category).toBe("shipment_created_notification_policy");
    expect(settingsRows[0]?.winning_scope_type).toBeTruthy();
  });

  test("returns one shipment-scoped timeline across actions, decisions, domain events, and outbound communications", async () => {
    const trackingNumber = `UI-TIMELINE-${Date.now()}`;
    const createResult = await client.query(
      `
        SELECT public.ui_create_shipment_v1(
          $1::uuid,
          $2::uuid,
          'delivery',
          $3::text,
          NULL,
          NULL,
          'pending',
          $4::jsonb
        ) AS result
      `,
      [
        clientId,
        senderId,
        trackingNumber,
        JSON.stringify({ source: "integration.ui_get_shipment_timeline" }),
      ]
    );

    const result = createResult.rows[0]?.result ?? {};
    expect(result.shipment_id).toBeTruthy();
    expect(result.workflow_run_id).toBeTruthy();
    expect(result.correlation_id).toBeTruthy();

    await setFixtureAdminContext(client);
    await client.query(
      `
        INSERT INTO shipment_actions (
          shipment_id,
          organization_id,
          client_id,
          action_type,
          action_category,
          notes,
          timestamp,
          created_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'note',
          'operational',
          'Timeline support note',
          now() - interval '3 minutes',
          now() - interval '3 minutes'
        )
      `,
      [result.shipment_id, organizationId, clientId]
    );
    await client.query(
      `
        INSERT INTO domain_events (
          organization_id,
          event_type,
          resource_type,
          resource_id,
          workflow_run_id,
          correlation_id,
          payload,
          status,
          created_at,
          updated_at,
          processed_at
        )
        VALUES (
          $1::uuid,
          'shipment_status_changed',
          'shipment',
          $2::uuid,
          $3::uuid,
          $4::uuid,
          '{"status":"pending"}'::jsonb,
          'completed',
          now() - interval '2 minutes',
          now() - interval '2 minutes',
          now() - interval '2 minutes'
        )
      `,
      [organizationId, result.shipment_id, result.workflow_run_id, result.correlation_id]
    );
    await client.query(
      `
        INSERT INTO outbound_calls (
          call_type,
          target_type,
          target_id,
          url,
          method,
          headers,
          body,
          status,
          priority,
          retry_count,
          max_retries,
          response_status_code,
          latency_ms,
          correlation_id,
          shipment_id,
          context,
          created_at,
          completed_at
        )
        VALUES (
          'comms_whatsapp',
          'recipient',
          gen_random_uuid(),
          'https://example.test/messages',
          'POST',
          '{}'::jsonb,
          '{}'::jsonb,
          'completed',
          0,
          0,
          3,
          200,
          42,
          $1::uuid,
          $2::uuid,
          '{"source":"integration.ui_get_shipment_timeline"}'::jsonb,
          now() - interval '1 minute',
          now() - interval '50 seconds'
        )
      `,
      [result.correlation_id, result.shipment_id]
    );
    await setAuthContext(client, userId);

    const { rows } = await client.query(
      `
        SELECT public.ui_get_shipment_timeline_v1($1::uuid) AS timeline
      `,
      [result.shipment_id]
    );

    const timeline = rows[0]?.timeline ?? {};
    const events = Array.isArray(timeline.timeline_events) ? timeline.timeline_events : [];
    const communicationEvent = events.find(
      (event) =>
        event?.event_source === "outbound_communication"
        && event?.event_type === "comms_whatsapp"
    );

    expect(timeline.shipment_id).toBe(result.shipment_id);
    expect(
      events.some(
        (event) =>
          event?.event_source === "shipment_action"
          && event?.event_type === "note"
          && event?.summary === "Timeline support note"
      )
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event?.event_source === "domain_event"
          && event?.event_type === "shipment_status_changed"
          && event?.correlation_id === result.correlation_id
      )
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event?.event_source === "decision_log"
          && event?.correlation_id === result.correlation_id
      )
    ).toBe(true);
    expect(communicationEvent?.status).toBe("completed");
    expect(communicationEvent?.metadata?.response_status_code).toBe(200);
    expect(communicationEvent?.metadata?.latency_ms).toBe(42);
  });

  test("searches shipments by identifier across shipment fields, references, phone, and correlation id", async () => {
    const trackingNumber = `UI-SEARCH-${Date.now()}`;
    const clientReferenceNumber = `UI-SEARCH-REF-${Date.now()}`;
    const carrierReferenceNumber = `UI-CARRIER-${Date.now()}`;
    const lmdSystemReference = `UI-LMD-${Date.now()}`;
    const externalReference = `UI-EXT-${Date.now()}`;
    const recipientPhone = "+966 55 123 4567";
    const createResult = await client.query(
      `
        SELECT public.ui_create_shipment_v1(
          $1::uuid,
          $2::uuid,
          'delivery',
          $3::text,
          $4::text,
          NULL,
          'pending',
          $5::jsonb
        ) AS result
      `,
      [
        clientId,
        senderId,
        trackingNumber,
        clientReferenceNumber,
        JSON.stringify({ source: "integration.ui_identifier_search" }),
      ]
    );
    const result = createResult.rows[0]?.result ?? {};
    expect(result.shipment_id).toBeTruthy();
    expect(result.correlation_id).toBeTruthy();

    await setFixtureAdminContext(client);
    const recipientId = await insertRecipient({
      organizationId,
      clientId,
      name: "Identifier Search Recipient",
      phoneNumber: recipientPhone,
    });
    await client.query(
      `
        UPDATE public.shipments
           SET recipient_id = $2::uuid,
               carrier_reference_number = $3::text,
               lmd_system_reference = $4::text,
               updated_at = now()
         WHERE id = $1::uuid
      `,
      [result.shipment_id, recipientId, carrierReferenceNumber, lmdSystemReference]
    );
    await client.query(
      `
        INSERT INTO public.shipment_reference_numbers (
          organization_id,
          client_id,
          shipment_id,
          reference_type,
          reference_value,
          source_type,
          metadata
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'client_reference_number',
          $4::text,
          'integration_test',
          '{}'::jsonb
        )
      `,
      [organizationId, clientId, result.shipment_id, externalReference]
    );
    await setAuthContext(client, userId);

    for (const candidate of [
      trackingNumber,
      clientReferenceNumber,
      carrierReferenceNumber,
      lmdSystemReference,
      externalReference,
      recipientPhone,
      result.correlation_id,
      result.shipment_id,
    ]) {
      const payload = await listShipmentsByIdentifier(candidate);
      expect(payload.resource).toBe("shipments");
      expect(payload.total).toBe(1);
      expect(payload.items[0]?.id).toBe(result.shipment_id);
    }

    const metrics = await shipmentMetricsByIdentifier(result.correlation_id);
    expect(metrics.resource).toBe("shipments");
    expect(metrics.total).toBe(1);
  });

  test("keeps correlation identifier search capability-gated for shipment-only readers", async () => {
    const trackingNumber = `UI-SEARCH-LIMITED-${Date.now()}`;
    const createResult = await client.query(
      `
        SELECT public.ui_create_shipment_v1(
          $1::uuid,
          $2::uuid,
          'delivery',
          $3::text,
          NULL,
          NULL,
          'pending',
          '{}'::jsonb
        ) AS result
      `,
      [clientId, senderId, trackingNumber]
    );
    const result = createResult.rows[0]?.result ?? {};

    await setAuthContext(client, limitedUserId);

    const shipmentPayload = await listShipmentsByIdentifier(trackingNumber);
    expect(shipmentPayload.total).toBe(1);
    expect(shipmentPayload.items[0]?.id).toBe(result.shipment_id);

    const correlationPayload = await listShipmentsByIdentifier(result.correlation_id);
    expect(correlationPayload.total).toBe(0);
    expect(Array.isArray(correlationPayload.items)).toBe(true);
    expect(correlationPayload.items).toHaveLength(0);
  });

  test("keeps identifier search tenant scoped", async () => {
    const foreignTrackingNumber = `UI-SEARCH-FOREIGN-${Date.now()}`;
    await setFixtureAdminContext(client);
    const { rows: shipmentRows } = await client.query(
      `
        INSERT INTO public.shipments (
          organization_id,
          client_id,
          sender_id,
          service_type,
          tracking_number,
          status,
          box_count
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'delivery',
          $4::text,
          'pending',
          1
        )
        RETURNING id
      `,
      [otherOrganizationId, otherClientId, otherSenderId, foreignTrackingNumber]
    );
    const foreignShipmentId = shipmentRows[0]?.id ?? null;

    await setAuthContext(client, userId);
    const deniedPayload = await listShipmentsByIdentifier(foreignTrackingNumber);
    expect(deniedPayload.total).toBe(0);
    expect(deniedPayload.items).toHaveLength(0);

    await setAuthContext(client, otherUserId);
    const allowedPayload = await listShipmentsByIdentifier(foreignTrackingNumber);
    expect(allowedPayload.total).toBe(1);
    expect(allowedPayload.items[0]?.id).toBe(foreignShipmentId);
  });

  test("reuses the existing shipment when duplicate tracking is submitted", async () => {
    const trackingNumber = `UI-DUP-${Date.now()}`;
    const first = await client.query(
      `
        SELECT public.ui_create_shipment_v1(
          $1::uuid,
          $2::uuid,
          'delivery',
          $3::text,
          NULL,
          NULL,
          'pending',
          '{}'::jsonb
        ) AS result
      `,
      [clientId, senderId, trackingNumber]
    );
    const firstResult = first.rows[0]?.result ?? {};
    expect(firstResult.shipment_id).toBeTruthy();

    const duplicate = await client.query(
      `
        SELECT public.ui_create_shipment_v1(
          $1::uuid,
          $2::uuid,
          'delivery',
          $3::text,
          NULL,
          NULL,
          'pending',
          '{}'::jsonb
        ) AS result
      `,
      [clientId, senderId, trackingNumber]
    );
    const duplicateResult = duplicate.rows[0]?.result ?? {};
    expect(duplicateResult.shipment_id).toBe(firstResult.shipment_id);
    expect(duplicateResult.operation).toBe("reused");

    const { rows: countRows } = await client.query(
      `
        SELECT COUNT(*)::int AS count
        FROM shipments
        WHERE client_id = $1::uuid
          AND tracking_upper = upper($2)
      `,
      [clientId, trackingNumber]
    );
    expect(countRows[0]?.count).toBe(1);

    const { rows: stepRows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `
        SELECT operation_result
        FROM workflow_run_steps
        WHERE workflow_run_id = $1::uuid
          AND handler_key = 'shipment_create'
        ORDER BY sequence_order
        LIMIT 1
      `,
      [duplicateResult.workflow_run_id]
    ));
    expect(stepRows[0]?.operation_result?.operation).toBe("reused");
  });

  test("exposes the shipment timeline RPC through api schema for browser clients", async () => {
    const trackingNumber = `UI-API-TIMELINE-${Date.now()}`;
    const createResult = await client.query(
      `
        SELECT public.ui_create_shipment_v1(
          $1::uuid,
          $2::uuid,
          'delivery',
          $3::text,
          NULL,
          NULL,
          'pending',
          $4::jsonb
        ) AS result
      `,
      [
        clientId,
        senderId,
        trackingNumber,
        JSON.stringify({ source: "integration.api.ui_get_shipment_timeline" }),
      ]
    );
    const result = createResult.rows[0]?.result ?? {};

    const { rows } = await client.query(
      `
        SELECT api.ui_get_shipment_timeline_v1($1::uuid) AS timeline
      `,
      [result.shipment_id]
    );

    const timeline = rows[0]?.timeline ?? {};
    const events = Array.isArray(timeline.timeline_events) ? timeline.timeline_events : [];
    expect(timeline.shipment_id).toBe(result.shipment_id);
    expect(
      events.some(
        (event) =>
          event?.event_source === "decision_log"
          && event?.correlation_id === result.correlation_id
      )
    ).toBe(true);
  });

  test("omits audit and request timeline slices for shipment-only readers", async () => {
    const trackingNumber = `UI-TIMELINE-LIMITED-${Date.now()}`;
    const createResult = await client.query(
      `
        SELECT public.ui_create_shipment_v1(
          $1::uuid,
          $2::uuid,
          'delivery',
          $3::text,
          NULL,
          NULL,
          'pending',
          '{}'::jsonb
        ) AS result
      `,
      [clientId, senderId, trackingNumber]
    );
    const result = createResult.rows[0]?.result ?? {};

    await setFixtureAdminContext(client);
    await client.query(
      `
        INSERT INTO public.shipment_actions (
          shipment_id,
          organization_id,
          client_id,
          action_type,
          action_category,
          notes,
          timestamp,
          created_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'note',
          'timeline',
          'Limited timeline note',
          now(),
          now()
        )
      `,
      [result.shipment_id, organizationId, clientId]
    );

    await client.query(
      `
        INSERT INTO public.decision_log (
          organization_id,
          decision_category,
          decision_point,
          decision_outcome,
          resource_type,
          resource_id,
          performed_by_system,
          timestamp
        )
        VALUES (
          $1::uuid,
          'shipment_create',
          'shipment_create',
          'completed',
          'shipment',
          $2::uuid,
          'workflow_engine',
          now()
        )
      `,
      [organizationId, result.shipment_id]
    );

    await client.query(
      `
        INSERT INTO public.domain_events (
          organization_id,
          event_type,
          resource_type,
          resource_id,
          status,
          payload
        )
        VALUES (
          $1::uuid,
          'shipment.updated',
          'shipment',
          $2::uuid,
          'completed',
          '{}'::jsonb
        )
      `,
      [organizationId, result.shipment_id]
    );

    await client.query(
      `
        INSERT INTO public.outbound_calls (
          call_type,
          target_type,
          target_id,
          url,
          method,
          headers,
          body,
          status,
          priority,
          retry_count,
          max_retries,
          shipment_id,
          context,
          created_at
        )
        VALUES (
          'comms_sms',
          'recipient',
          gen_random_uuid(),
          'https://example.test/messages',
          'POST',
          '{}'::jsonb,
          '{}'::jsonb,
          'completed',
          0,
          0,
          3,
          $1::uuid,
          '{"source":"integration.ui_get_shipment_timeline.limited"}'::jsonb,
          now()
        )
      `,
      [result.shipment_id]
    );

    await setAuthContext(client, limitedUserId);

    const { rows } = await client.query(
      `
        SELECT public.ui_get_shipment_timeline_v1($1::uuid) AS timeline
      `,
      [result.shipment_id]
    );

    const timeline = rows[0]?.timeline ?? {};
    const events = Array.isArray(timeline.timeline_events) ? timeline.timeline_events : [];

    expect(timeline.shipment_id).toBe(result.shipment_id);
    expect(
      events.some(
        (event) =>
          event?.event_source === "shipment_action" && event?.summary === "Limited timeline note"
      )
    ).toBe(true);
    expect(events.some((event) => event?.event_source === "decision_log")).toBe(false);
    expect(events.some((event) => event?.event_source === "domain_event")).toBe(false);
  });

  test("denies shipment timeline reads across tenants", async () => {
    const trackingNumber = `UI-TIMELINE-DENY-${Date.now()}`;
    const createResult = await client.query(
      `
        SELECT public.ui_create_shipment_v1(
          $1::uuid,
          $2::uuid,
          'delivery',
          $3::text,
          NULL,
          NULL,
          'pending',
          '{}'::jsonb
        ) AS result
      `,
      [clientId, senderId, trackingNumber]
    );
    const result = createResult.rows[0]?.result ?? {};

    await setAuthContext(client, otherUserId);

    await expect(
      client.query(
        `
          SELECT public.ui_get_shipment_timeline_v1($1::uuid) AS timeline
        `,
        [result.shipment_id]
      )
    ).rejects.toThrow(/not found or inaccessible/i);
  });

  test("exposes the shipment-create RPC through api schema for browser clients", async () => {
    const trackingNumber = `UI-API-${Date.now()}`;
    const clientReferenceNumber = `UI-API-REF-${Date.now()}`;
    const { rows } = await client.query(
      `
        SELECT api.ui_create_shipment_v1(
          $1::uuid,
          $2::uuid,
          $3::text,
          $4::text,
          $5::text,
          NULL,
          $6::text,
          $7::jsonb
        ) AS result
      `,
      [
        clientId,
        senderId,
        "delivery",
        trackingNumber,
        clientReferenceNumber,
        "pending",
        JSON.stringify({ source: "integration.api.ui_create_shipment" }),
      ]
    );

    const result = rows[0]?.result ?? {};
    expect(result.status).toBe("shipment_created");
    expect(result.shipment_id).toBeTruthy();
    expect(result.workflow_run_id).toBeTruthy();
    expect(result.correlation_id).toBeTruthy();
    expect(result.tracking_number).toBe(trackingNumber);

    const { rows: shipmentRows } = await client.query(
      `
        SELECT id::text AS id, tracking_number, client_reference_number
        FROM shipments
        WHERE id = $1::uuid
      `,
      [result.shipment_id]
    );
    expect(shipmentRows[0]?.id).toBe(result.shipment_id);
    expect(shipmentRows[0]?.tracking_number).toBe(trackingNumber);
    expect(shipmentRows[0]?.client_reference_number).toBe(clientReferenceNumber);
  });
});
