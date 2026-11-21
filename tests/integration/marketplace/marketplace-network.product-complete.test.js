// Plan: PLAN-202603-marketplace-network-product-complete / Step: S95
// Product-complete marketplace lifecycle integration coverage.

const {
  assertDatabaseUrl,
  pool,
  createOrganization,
  createUser,
  setAuthContext,
  withFixtureAdminContext,
} = require("../helpers/tenant-utils");

function parseResult(rowValue, label) {
  if (!rowValue || typeof rowValue !== "object" || Array.isArray(rowValue)) {
    throw new Error(`${label} returned an invalid payload`);
  }
  return rowValue;
}

async function callMarketplace(client, sql, params, label) {
  const { rows } = await client.query(sql, params);
  return parseResult(rows[0]?.result, label);
}

describe("marketplace network product-complete lifecycle", () => {
  beforeAll(() => {
    assertDatabaseUrl("marketplace-network.product-complete");
  });

  afterAll(async () => {
    await pool.end().catch(() => {});
  });

  test("shipment-batch request runs through workboard, workspace, contract room, settlement reversal, and token status", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const requesterOrg = await createOrganization(client, "Marketplace PC Requester");
      const supplierOrg = await createOrganization(client, "Marketplace PC Supplier");

      const requesterUserId = await createUser(
        client,
        requesterOrg.id,
        `marketplace-pc-requester-${Date.now()}@example.com`,
        { userType: "ops_admin" },
      );
      const supplierUserId = await createUser(
        client,
        supplierOrg.id,
        `marketplace-pc-supplier-${Date.now()}@example.com`,
        { userType: "ops_admin" },
      );

      await setAuthContext(client, supplierUserId);
      const optIn = await callMarketplace(
        client,
        `SELECT public.marketplace_provider_opt_in_v1(
           p_display_name := $1::text,
           p_profile := $2::jsonb,
           p_capabilities := $3::jsonb
         ) AS result`,
        [
          "Supplier Product Complete Team",
          JSON.stringify({ operating_cities: ["Riyadh"], fleet_size: 4 }),
          JSON.stringify(["fragile", "cold_chain"]),
        ],
        "marketplace_provider_opt_in_v1",
      );
      expect(optIn).toMatchObject({ ok: true, status: "approved" });

      await client.query("RESET ROLE");
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ role: "service_role" }),
      ]);
      await client.query("SELECT set_config('request.jwt.claim.sub', '', true)");

      const participantRequest = await callMarketplace(
        client,
        `SELECT public.marketplace_participant_request_create_v1(
           p_requested_participant_type_key := $1::text,
           p_email := $2::text,
           p_full_name := $3::text,
           p_organization_name := $4::text,
           p_metadata := $5::jsonb,
           p_ip_hash := $6::text,
           p_turnstile_verified := TRUE
         ) AS result`,
        [
          "freelancer_driver",
          `marketplace-pc-status-${Date.now()}@example.com`,
          "Marketplace Status Token",
          "Marketplace Status Token",
          JSON.stringify({ source: "marketplace-network.product-complete.status" }),
          `marketplace-pc-status-${Date.now()}`,
        ],
        "marketplace_participant_request_create_v1",
      );
      expect(participantRequest).toMatchObject({ ok: true, status: "pending" });
      expect(String(participantRequest.task_id || "")).toMatch(/^[0-9a-f-]{36}$/i);
      expect(String(participantRequest.application_status_token || "")).toMatch(
        /^[0-9a-f-]{36}$/i,
      );

      const participantRequestRow = await client.query(
        `SELECT
           status,
           last_error_code,
           last_error_message,
           (
             SELECT t.id
               FROM public.tasks t
              WHERE t.resource_type = 'marketplace_participant_request'
                AND t.resource_id = r.id
              ORDER BY t.created_at DESC
              LIMIT 1
           ) AS review_task_id
         FROM public.marketplace_participant_requests r
         WHERE r.id = $1::uuid`,
        [participantRequest.id],
      );
      expect(participantRequestRow.rows[0]?.status).toBe("pending");
      expect(participantRequestRow.rows[0]?.last_error_code ?? null).toBeNull();
      expect(participantRequestRow.rows[0]?.last_error_message ?? null).toBeNull();
      expect(participantRequestRow.rows[0]?.review_task_id).toBe(participantRequest.task_id);

      await setAuthContext(client, requesterUserId);
      const requestTitle = `Shipment batch ${Date.now()}`;
      const createRequest = await callMarketplace(
        client,
        `SELECT public.marketplace_request_create_v1(
           p_request_kind_key := $1::text,
           p_title := $2::text,
           p_summary := $3::text,
           p_request_details := $4::jsonb,
           p_items := $5::jsonb,
           p_private_pool := $6::jsonb,
           p_expires_at := NULL,
           p_metadata := $7::jsonb
         ) AS result`,
        [
          "shipment_batch",
          requestTitle,
          "Shipment-batch overflow coverage for Riyadh.",
          JSON.stringify({
            service_date: "2026-03-09",
            pickup_city: "Riyadh",
            dropoff_city: "Riyadh",
            shipment_count: 64,
            required_capabilities: ["fragile"],
            pricing_guidance: { amount: 1250, currency: "SAR" },
          }),
          JSON.stringify([]),
          JSON.stringify([supplierOrg.id]),
          JSON.stringify({ source: "marketplace-network.product-complete.request" }),
        ],
        "marketplace_request_create_v1",
      );
      expect(createRequest).toMatchObject({ ok: true, status: "draft" });
      const requestId = String(createRequest.id || "");
      expect(requestId).toBeTruthy();

      const publishRequest = await callMarketplace(
        client,
        `SELECT public.marketplace_request_publish_v1(
           p_request_id := $1::uuid,
           p_release_state := $2::text
         ) AS result`,
        [requestId, "private_pool"],
        "marketplace_request_publish_v1",
      );
      expect(publishRequest).toMatchObject({ ok: true, status: "published" });

      await setAuthContext(client, supplierUserId);
      const workboard = await callMarketplace(
        client,
        `SELECT public.marketplace_provider_workboard_v1(
           p_include_closed := FALSE
         ) AS result`,
        [],
        "marketplace_provider_workboard_v1",
      );
      const visibleRequests = Array.isArray(workboard.visible_requests)
        ? workboard.visible_requests
        : [];
      expect(visibleRequests.some((entry) => entry.id === requestId)).toBe(true);

      const submitOffer = await callMarketplace(
        client,
        `SELECT public.marketplace_offer_submit_v1(
           p_request_id := $1::uuid,
           p_message := $2::text,
           p_terms := $3::jsonb,
           p_pricing := $4::jsonb,
           p_expires_at := NULL,
           p_metadata := $5::jsonb
         ) AS result`,
        [
          requestId,
          "Supplier can cover the full shipment batch.",
          JSON.stringify({ vehicle_mix: ["van"], service_level: "same_day" }),
          JSON.stringify({ amount: 1499, currency: "SAR" }),
          JSON.stringify({ source: "marketplace-network.product-complete.offer" }),
        ],
        "marketplace_offer_submit_v1",
      );
      expect(submitOffer).toMatchObject({ ok: true, status: "submitted" });
      const offerId = String(submitOffer.id || "");
      expect(offerId).toBeTruthy();

      await setAuthContext(client, requesterUserId);
      const requestWorkspace = await callMarketplace(
        client,
        `SELECT public.marketplace_request_workspace_v1($1::uuid) AS result`,
        [requestId],
        "marketplace_request_workspace_v1",
      );
      expect(requestWorkspace).toMatchObject({ ok: true });
      expect(Array.isArray(requestWorkspace.offers)).toBe(true);
      expect(requestWorkspace.offers.some((entry) => entry.id === offerId)).toBe(true);
      expect(Array.isArray(requestWorkspace.private_pool_memberships)).toBe(true);
      expect(
        requestWorkspace.private_pool_memberships.some(
          (entry) => entry.supplier_organization_id === supplierOrg.id,
        ),
      ).toBe(true);

      const privatePoolsWorkspace = await callMarketplace(
        client,
        `SELECT public.marketplace_private_pools_workspace_v1(
           p_requester_organization_id := $1::uuid
         ) AS result`,
        [requesterOrg.id],
        "marketplace_private_pools_workspace_v1",
      );
      expect(privatePoolsWorkspace).toMatchObject({ ok: true });
      expect(Array.isArray(privatePoolsWorkspace.private_pools)).toBe(true);
      expect(
        privatePoolsWorkspace.private_pools.some(
          (entry) =>
            entry.request_id === requestId
            && entry.supplier_organization_id === supplierOrg.id,
        ),
      ).toBe(true);

      const counterOffer = await callMarketplace(
        client,
        `SELECT public.marketplace_offer_counter_v1(
           p_offer_id := $1::uuid,
           p_message := $2::text,
           p_terms := $3::jsonb,
           p_pricing := $4::jsonb,
           p_expires_at := NULL,
           p_metadata := $5::jsonb
         ) AS result`,
        [
          offerId,
          "Countering with final SAR 1450.",
          JSON.stringify({ vehicle_mix: ["van"], service_level: "same_day", pod_required: true }),
          JSON.stringify({ amount: 1450, currency: "SAR" }),
          JSON.stringify({ source: "marketplace-network.product-complete.counter" }),
        ],
        "marketplace_offer_counter_v1",
      );
      expect(counterOffer).toMatchObject({ ok: true, status: "countered" });

      const awardOffer = await callMarketplace(
        client,
        `SELECT public.marketplace_award_offer_v1(
           p_offer_id := $1::uuid,
           p_award_reason := $2::text,
           p_award_terms := $3::jsonb,
           p_expires_at := NULL,
           p_metadata := $4::jsonb
         ) AS result`,
        [
          offerId,
          "Preferred provider after counter negotiation",
          JSON.stringify({ amount: 1450, currency: "SAR", proof_requirements: ["photo", "signature"] }),
          JSON.stringify({ source: "marketplace-network.product-complete.award" }),
        ],
        "marketplace_award_offer_v1",
      );
      expect(awardOffer).toMatchObject({ ok: true, status: "pending_acceptance" });
      const awardId = String(awardOffer.id || "");
      expect(awardId).toBeTruthy();

      await setAuthContext(client, supplierUserId);
      const acceptAward = await callMarketplace(
        client,
        `SELECT public.marketplace_award_respond_v1(
           p_award_id := $1::uuid,
           p_decision := $2::text,
           p_metadata := $3::jsonb
         ) AS result`,
        [
          awardId,
          "accepted",
          JSON.stringify({ source: "marketplace-network.product-complete.accept" }),
        ],
        "marketplace_award_respond_v1",
      );
      expect(acceptAward).toMatchObject({ ok: true, status: "accepted" });
      const workPackageId = String(acceptAward.work_package_id || "");
      const contractId = String(acceptAward.contract_id || "");
      expect(workPackageId).toBeTruthy();
      expect(contractId).toBeTruthy();

      const completeWorkPackage = await callMarketplace(
        client,
        `SELECT public.marketplace_work_package_complete_v1(
           p_work_package_id := $1::uuid,
           p_proof := $2::jsonb,
           p_metadata := $3::jsonb
         ) AS result`,
        [
          workPackageId,
          JSON.stringify({ proof_quality: 5, feedback_score: 5, delivered_count: 64 }),
          JSON.stringify({ source: "marketplace-network.product-complete.complete" }),
        ],
        "marketplace_work_package_complete_v1",
      );
      expect(completeWorkPackage).toMatchObject({ ok: true, status: "settled" });

      await setAuthContext(client, requesterUserId);
      const finalizeSettlement = await callMarketplace(
        client,
        `SELECT public.marketplace_settlement_finalize_v1(
           p_work_package_id := $1::uuid,
           p_contract_id := $2::uuid,
           p_metadata := $3::jsonb
         ) AS result`,
        [
          workPackageId,
          contractId,
          JSON.stringify({ source: "marketplace-network.product-complete.settlement" }),
        ],
        "marketplace_settlement_finalize_v1",
      );
      expect(finalizeSettlement).toMatchObject({ ok: true, status: "settled" });

      const contractRoom = await callMarketplace(
        client,
        `SELECT public.marketplace_contract_room_v1($1::uuid) AS result`,
        [contractId],
        "marketplace_contract_room_v1",
      );
      expect(contractRoom).toMatchObject({ ok: true });
      expect(Array.isArray(contractRoom.settlements)).toBe(true);
      expect(contractRoom.settlements.length).toBeGreaterThan(0);
      expect(Array.isArray(contractRoom.finance_events)).toBe(true);
      expect(contractRoom.finance_events.length).toBeGreaterThan(0);

      const settlementWorkspace = await callMarketplace(
        client,
        `SELECT public.marketplace_settlement_workspace_v1(
           p_contract_id := $1::uuid,
           p_work_package_id := $2::uuid
         ) AS result`,
        [contractId, workPackageId],
        "marketplace_settlement_workspace_v1",
      );
      expect(settlementWorkspace).toMatchObject({ ok: true });
      expect(Array.isArray(settlementWorkspace.settlements)).toBe(true);
      expect(settlementWorkspace.settlements.length).toBeGreaterThan(0);

      const statusByToken = await callMarketplace(
        client,
        `SELECT public.marketplace_application_status_by_token_v1($1::uuid) AS result`,
        [participantRequest.application_status_token],
        "marketplace_application_status_by_token_v1",
      );
      expect(statusByToken).toMatchObject({
        ok: true,
        status: "pending",
        application_state: "pending_review",
      });

      const requestRow = await client.query(
        `SELECT status
           FROM public.marketplace_requests
          WHERE id = $1::uuid`,
        [requestId],
      );
      expect(requestRow.rows[0]?.status).toBe("settled");

      const contractRow = await client.query(
        `SELECT status
           FROM public.marketplace_contracts
          WHERE id = $1::uuid`,
        [contractId],
      );
      expect(contractRow.rows[0]?.status).toBe("settled");

      const workPackageRow = await client.query(
        `SELECT status
           FROM public.marketplace_work_packages
          WHERE id = $1::uuid`,
        [workPackageId],
      );
      expect(workPackageRow.rows[0]?.status).toBe("settled");

      const originalSettlement = settlementWorkspace.work_package.metadata.settlement;
      expect(originalSettlement).toMatchObject({ amount: 1450, currency: "SAR" });

      const reversalReason = "Reverse the synthetic shipment batch";
      const reversal = await callMarketplace(
        client,
        `SELECT public.marketplace_settlement_reverse_v1($1::uuid, $2::text) AS result`,
        [workPackageId, reversalReason],
        "marketplace_settlement_reverse_v1",
      );
      expect(reversal).toMatchObject({ ok: true, id: workPackageId, status: "completed" });

      const reversedWorkspace = await callMarketplace(
        client,
        `SELECT public.marketplace_settlement_workspace_v1($1::uuid, $2::uuid) AS result`,
        [contractId, workPackageId],
        "marketplace_settlement_workspace_v1 after reversal",
      );
      expect(reversedWorkspace).toMatchObject({
        ok: true,
        contract: { id: contractId, status: "completed" },
        work_package: {
          id: workPackageId,
          status: "completed",
          metadata: {
            settlement: originalSettlement,
            settlement_reversal: {
              reason: reversalReason,
              requester_finance_event_id: reversal.requester_finance_event_id,
              supplier_finance_event_id: reversal.supplier_finance_event_id,
              requester_settlement_batch_id: reversal.requester_settlement_batch_id,
              supplier_settlement_batch_id: reversal.supplier_settlement_batch_id,
            },
          },
        },
      });

      const { rows: ledger } = await withFixtureAdminContext(client, () => client.query(
        `SELECT sb.id AS batch_id, sb.kind, sb.status, fe.id AS finance_event_id,
                fe.organization_id, fe.event_type, fe.direction, fe.amount::text, fe.currency
           FROM public.settlement_batches sb
           JOIN public.settlement_batch_finance_events member
             ON member.settlement_batch_id = sb.id AND member.organization_id = sb.organization_id
           JOIN public.finance_events fe
             ON fe.id = member.finance_event_id AND fe.organization_id = member.organization_id
            AND fe.occurred_at = member.finance_occurred_at
          WHERE sb.subject_type = 'marketplace_contract' AND sb.subject_id = $1::uuid
            AND fe.subject_type = 'marketplace_contract' AND fe.subject_id = sb.subject_id
            AND fe.metadata->>'marketplace_work_package_id' = $2`,
        [contractId, workPackageId],
      ));
      expect(ledger).toHaveLength(4);
      for (const [receipt, phase, payableDirection, receivableDirection] of [
        [originalSettlement, "recorded", "debit", "credit"],
        [reversal, "reversal", "credit", "debit"],
      ]) {
        expect(ledger).toContainEqual({
          batch_id: receipt.requester_settlement_batch_id,
          kind: "billing",
          status: "posted",
          finance_event_id: receipt.requester_finance_event_id,
          organization_id: requesterOrg.id,
          event_type: `marketplace_payable_${phase}`,
          direction: payableDirection,
          amount: "1450",
          currency: "SAR",
        });
        expect(ledger).toContainEqual({
          batch_id: receipt.supplier_settlement_batch_id,
          kind: "payout",
          status: "posted",
          finance_event_id: receipt.supplier_finance_event_id,
          organization_id: supplierOrg.id,
          event_type: `marketplace_receivable_${phase}`,
          direction: receivableDirection,
          amount: "1450",
          currency: "SAR",
        });
      }

      for (const side of ["requester", "supplier"]) {
        const posted = ledger.find((event) => event.finance_event_id === originalSettlement[side + "_finance_event_id"]);
        const reversed = ledger.find((event) => event.finance_event_id === reversal[side + "_finance_event_id"]);
        expect(posted.amount).toBe(String(originalSettlement.amount));
        expect(reversed.amount).toBe(posted.amount);
      }

      const outsideOrg = await createOrganization(client, "Marketplace Outside Tenant");
      const outsideUserId = await createUser(
        client, outsideOrg.id, `marketplace-outside-${outsideOrg.id}@example.com`, { userType: "ops_admin" },
      );
      await setAuthContext(client, outsideUserId);
      const hiddenWorkspace = await callMarketplace(
        client,
        `SELECT public.marketplace_settlement_workspace_v1($1::uuid, $2::uuid) AS result`,
        [contractId, workPackageId],
        "marketplace_settlement_workspace_v1 outside tenant",
      );
      expect(hiddenWorkspace).toEqual({ ok: false, error: { code: "contract_not_found" } });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
