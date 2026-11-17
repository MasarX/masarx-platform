// Plan: PLAN-202603-marketplace-network-v1 / Step: S95
// Marketplace network lifecycle integration coverage.

const {
  assertDatabaseUrl,
  pool,
  createOrganization,
  createUser,
  setAuthContext,
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

describe("marketplace network lifecycle", () => {
  beforeAll(() => {
    assertDatabaseUrl("marketplace-network.lifecycle");
  });

  afterAll(async () => {
    await pool.end().catch(() => {});
  });

  test("provider tenant lifecycle runs from request to dispute resolution", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const requesterOrg = await createOrganization(client, "Marketplace Requester Org");
      const supplierOrg = await createOrganization(client, "Marketplace Supplier Org");
      const reviewerOrg = await createOrganization(client, "Marketplace Review Org");

      const requesterUserId = await createUser(
        client,
        requesterOrg.id,
        `marketplace-requester-${Date.now()}@example.com`,
        { userType: "ops_admin" },
      );
      const supplierUserId = await createUser(
        client,
        supplierOrg.id,
        `marketplace-supplier-${Date.now()}@example.com`,
        { userType: "ops_admin" },
      );
      const reviewerUserId = await createUser(
        client,
        reviewerOrg.id,
        `marketplace-reviewer-${Date.now()}@example.com`,
        { userType: "ops_admin", accessScopeType: "platform" },
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
          "Supplier Marketplace Team",
          JSON.stringify({ operating_cities: ["Riyadh"] }),
          JSON.stringify(["cold_chain", "fragile"]),
        ],
        "marketplace_provider_opt_in_v1",
      );
      expect(optIn).toMatchObject({ ok: true, status: "approved" });
      const supplierProfileId = String(optIn.participant_profile_id || "");
      expect(supplierProfileId).toBeTruthy();

      await setAuthContext(client, requesterUserId);
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
          "capacity_block",
          `Capacity block ${Date.now()}`,
          "Overflow capacity block for Riyadh.",
          JSON.stringify({
            city: "Riyadh",
            service_date: "2026-03-09",
            shipment_capacity: 150,
            required_capabilities: ["cold_chain"],
          }),
          JSON.stringify([]),
          JSON.stringify([supplierOrg.id]),
          JSON.stringify({ source: "marketplace-network.lifecycle.happy-path" }),
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
          "Supplier can cover Riyadh overflow.",
          JSON.stringify({ currency: "SAR", service_level: "same_day" }),
          JSON.stringify({ amount: 1250, rate_basis: "block" }),
          JSON.stringify({ source: "marketplace-network.lifecycle.offer" }),
        ],
        "marketplace_offer_submit_v1",
      );
      expect(submitOffer).toMatchObject({ ok: true, status: "submitted" });
      const offerId = String(submitOffer.id || "");
      expect(offerId).toBeTruthy();

      await setAuthContext(client, requesterUserId);
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
          "Best network fit",
          JSON.stringify({ proof_requirements: ["photo", "signature"] }),
          JSON.stringify({ source: "marketplace-network.lifecycle.award" }),
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
          JSON.stringify({ source: "marketplace-network.lifecycle.accept" }),
        ],
        "marketplace_award_respond_v1",
      );
      expect(acceptAward).toMatchObject({ ok: true, status: "accepted" });
      const workPackageId = String(acceptAward.work_package_id || "");
      expect(workPackageId).toBeTruthy();

      await setAuthContext(client, requesterUserId);
      const materialize = await callMarketplace(
        client,
        `SELECT public.marketplace_work_package_materialize_v1(
           p_work_package_id := $1::uuid,
           p_award_id := NULL,
           p_execution_ref := $2::jsonb,
           p_summary := $3::jsonb,
           p_metadata := $4::jsonb
         ) AS result`,
        [
          workPackageId,
          JSON.stringify({ execution_target: "manual", external_ref: "wp-bridge-001" }),
          JSON.stringify({ shipment_estimate: 150 }),
          JSON.stringify({ source: "marketplace-network.lifecycle.materialize" }),
        ],
        "marketplace_work_package_materialize_v1",
      );
      expect(materialize).toMatchObject({
        ok: true,
        id: workPackageId,
        materialization_state: "materialized",
      });

      const openDispute = await callMarketplace(
        client,
        `SELECT public.marketplace_dispute_open_v1(
           p_contract_id := NULL,
           p_work_package_id := $1::uuid,
           p_title := $2::text,
           p_description := $3::text,
           p_category := $4::text,
           p_metadata := $5::jsonb
         ) AS result`,
        [
          workPackageId,
          "Delivery capacity dispute",
          "Need to review the awarded shipment volume.",
          "capacity",
          JSON.stringify({ source: "marketplace-network.lifecycle.dispute" }),
        ],
        "marketplace_dispute_open_v1",
      );
      expect(openDispute).toMatchObject({ ok: true, status: "open" });
      const disputeId = String(openDispute.id || "");
      expect(disputeId).toBeTruthy();

      await setAuthContext(client, reviewerUserId);
      const resolveDispute = await callMarketplace(
        client,
        `SELECT public.marketplace_dispute_resolve_v1(
           p_dispute_id := $1::uuid,
           p_resolution := $2::text,
           p_status := $3::text,
           p_metadata := $4::jsonb
         ) AS result`,
        [
          disputeId,
          "Capacity dispute resolved during lifecycle test.",
          "resolved",
          JSON.stringify({ source: "marketplace-network.lifecycle.resolve" }),
        ],
        "marketplace_dispute_resolve_v1",
      );
      expect(resolveDispute).toMatchObject({ ok: true, status: "resolved" });

      const snapshot = await callMarketplace(
        client,
        `SELECT public.marketplace_reputation_snapshot_v1(
           p_participant_profile_id := $1::uuid,
           p_organization_id := NULL
         ) AS result`,
        [supplierProfileId],
        "marketplace_reputation_snapshot_v1",
      );
      expect(snapshot).toMatchObject({
        participant_profile_id: supplierProfileId,
      });
      expect(snapshot).toEqual(
        expect.objectContaining({
          participant_profile_id: supplierProfileId,
          event_count: expect.any(Number),
        }),
      );

      const requestRow = await client.query(
        `SELECT status, awarded_offer_id
           FROM public.marketplace_requests
          WHERE id = $1::uuid`,
        [requestId],
      );
      expect(requestRow.rows[0]?.status).toBe("executing");
      expect(requestRow.rows[0]?.awarded_offer_id).toBe(offerId);

      const contractRow = await client.query(
        `SELECT status
           FROM public.marketplace_contracts
          WHERE award_id = $1::uuid`,
        [awardId],
      );
      expect(contractRow.rows[0]?.status).toBe("executing");

      const workPackageRow = await client.query(
        `SELECT status, materialization_state
           FROM public.marketplace_work_packages
          WHERE id = $1::uuid`,
        [workPackageId],
      );
      expect(workPackageRow.rows[0]?.status).toBe("executing");
      expect(workPackageRow.rows[0]?.materialization_state).toBe("materialized");

      const disputeRow = await client.query(
        `SELECT status
           FROM public.marketplace_disputes
          WHERE id = $1::uuid`,
        [disputeId],
      );
      expect(disputeRow.rows[0]?.status).toBe("resolved");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  test("marketplace flow enforces draft gating, self-offer block, and single active award", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const requesterOrg = await createOrganization(client, "Marketplace Edge Requester");
      const supplierOneOrg = await createOrganization(client, "Marketplace Supplier One");
      const supplierTwoOrg = await createOrganization(client, "Marketplace Supplier Two");

      const requesterUserId = await createUser(
        client,
        requesterOrg.id,
        `marketplace-edge-requester-${Date.now()}@example.com`,
        { userType: "ops_admin" },
      );
      const supplierOneUserId = await createUser(
        client,
        supplierOneOrg.id,
        `marketplace-edge-supplier-one-${Date.now()}@example.com`,
        { userType: "ops_admin" },
      );
      const supplierTwoUserId = await createUser(
        client,
        supplierTwoOrg.id,
        `marketplace-edge-supplier-two-${Date.now()}@example.com`,
        { userType: "ops_admin" },
      );

      for (const [userId, displayName] of [
        [requesterUserId, "Requester Supply Team"],
        [supplierOneUserId, "Supplier One Team"],
        [supplierTwoUserId, "Supplier Two Team"],
      ]) {
        await setAuthContext(client, userId);
        const optIn = await callMarketplace(
          client,
          `SELECT public.marketplace_provider_opt_in_v1(
             p_display_name := $1::text,
             p_profile := '{}'::jsonb,
             p_capabilities := $2::jsonb
           ) AS result`,
          [displayName, JSON.stringify(["fragile"])],
          "marketplace_provider_opt_in_v1",
        );
        expect(optIn).toMatchObject({ ok: true, status: "approved" });
      }

      await setAuthContext(client, requesterUserId);
      const createRequest = await callMarketplace(
        client,
        `SELECT public.marketplace_request_create_v1(
           p_request_kind_key := $1::text,
           p_title := $2::text,
           p_summary := $3::text,
           p_request_details := $4::jsonb,
           p_items := '[]'::jsonb,
           p_private_pool := $5::jsonb,
           p_expires_at := NULL,
           p_metadata := '{}'::jsonb
         ) AS result`,
        [
          "capacity_block",
          `Capacity block edge ${Date.now()}`,
          "Request for edge-case coverage.",
          JSON.stringify({
            city: "Riyadh",
            service_date: "2026-03-10",
            shipment_capacity: 40,
          }),
          JSON.stringify([supplierOneOrg.id, supplierTwoOrg.id]),
        ],
        "marketplace_request_create_v1",
      );
      const requestId = String(createRequest.id || "");
      expect(createRequest).toMatchObject({ ok: true, status: "draft" });

      await setAuthContext(client, supplierOneUserId);
      const draftOffer = await callMarketplace(
        client,
        `SELECT public.marketplace_offer_submit_v1(
           p_request_id := $1::uuid,
           p_message := $2::text,
           p_terms := '{}'::jsonb,
           p_pricing := '{}'::jsonb,
           p_expires_at := NULL,
           p_metadata := '{}'::jsonb
         ) AS result`,
        [requestId, "Should fail while draft"],
        "marketplace_offer_submit_v1",
      );
      expect(draftOffer).toMatchObject({
        ok: false,
        error: { code: "request_not_open" },
      });

      await setAuthContext(client, requesterUserId);
      const selfOffer = await callMarketplace(
        client,
        `SELECT public.marketplace_offer_submit_v1(
           p_request_id := $1::uuid,
           p_message := $2::text,
           p_terms := '{}'::jsonb,
           p_pricing := '{}'::jsonb,
           p_expires_at := NULL,
           p_metadata := '{}'::jsonb
         ) AS result`,
        [requestId, "Requester trying to self-offer"],
        "marketplace_offer_submit_v1",
      );
      expect(selfOffer).toMatchObject({
        ok: false,
        error: { code: "self_offer_not_allowed" },
      });

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

      await setAuthContext(client, supplierOneUserId);
      const supplierOneOffer = await callMarketplace(
        client,
        `SELECT public.marketplace_offer_submit_v1(
           p_request_id := $1::uuid,
           p_message := $2::text,
           p_terms := '{}'::jsonb,
           p_pricing := $3::jsonb,
           p_expires_at := NULL,
           p_metadata := '{}'::jsonb
         ) AS result`,
        [requestId, "Supplier one quote", JSON.stringify({ amount: 400 })],
        "marketplace_offer_submit_v1",
      );
      const supplierOneOfferId = String(supplierOneOffer.id || "");
      expect(supplierOneOffer).toMatchObject({ ok: true, status: "submitted" });

      await setAuthContext(client, supplierTwoUserId);
      const supplierTwoOffer = await callMarketplace(
        client,
        `SELECT public.marketplace_offer_submit_v1(
           p_request_id := $1::uuid,
           p_message := $2::text,
           p_terms := '{}'::jsonb,
           p_pricing := $3::jsonb,
           p_expires_at := NULL,
           p_metadata := '{}'::jsonb
         ) AS result`,
        [requestId, "Supplier two quote", JSON.stringify({ amount: 450 })],
        "marketplace_offer_submit_v1",
      );
      const supplierTwoOfferId = String(supplierTwoOffer.id || "");
      expect(supplierTwoOffer).toMatchObject({ ok: true, status: "submitted" });

      await setAuthContext(client, requesterUserId);
      const firstAward = await callMarketplace(
        client,
        `SELECT public.marketplace_award_offer_v1(
           p_offer_id := $1::uuid,
           p_award_reason := 'Best first quote',
           p_award_terms := '{}'::jsonb,
           p_expires_at := NULL,
           p_metadata := '{}'::jsonb
         ) AS result`,
        [supplierOneOfferId],
        "marketplace_award_offer_v1",
      );
      expect(firstAward).toMatchObject({ ok: true, status: "pending_acceptance" });

      const secondAward = await callMarketplace(
        client,
        `SELECT public.marketplace_award_offer_v1(
           p_offer_id := $1::uuid,
           p_award_reason := 'Should be blocked',
           p_award_terms := '{}'::jsonb,
           p_expires_at := NULL,
           p_metadata := '{}'::jsonb
         ) AS result`,
        [supplierTwoOfferId],
        "marketplace_award_offer_v1",
      );
      expect(secondAward).toMatchObject({
        ok: false,
        error: { code: "request_not_open" },
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
