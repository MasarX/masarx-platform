const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const { loadEnv } = require('../../scripts/utils/load-env');
const { requireEnv } = require('../utils/test-env');

loadEnv();

jest.setTimeout(120_000);

const missing = requireEnv(['DATABASE_URL'], 'settlement billing/payout lifecycle integration');
const describeIfDb = missing ? describe.skip : describe;
const {
  applySetting,
  createClient,
  createOrganization,
  createSender,
  createUser,
  setAuthContext,
} = missing ? {} : require('./helpers/tenant-utils');

describeIfDb('settlement billing/payout lifecycle integration', () => {
  let pool;
  let client;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const connection = await pool.connect();
    await connection.query('SELECT 1');
    connection.release();
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
      client = null;
    }
  });

  async function setServiceContext(organizationId, userId) {
    await client.query('SET LOCAL ROLE service_role');
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({
        role: 'service_role',
        sub: String(userId),
        organization_id: String(organizationId),
      }),
    ]);
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [String(userId)]);
    await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`);
  }

  async function requireLookupValue(category, value) {
    const { rows } = await client.query(
      `SELECT lv.value
         FROM public.lookup_definitions ld
         JOIN public.lookup_values lv
           ON lv.lookup_definition_id = ld.id
        WHERE ld.category = $1
          AND lv.value = $2
          AND lv.status = 'active'
        LIMIT 1`,
      [category, value],
    );

    expect(rows[0]?.value).toBe(value);
    return rows[0].value;
  }

  async function createSettlementBatch(input) {
    const { rows } = await client.query(
      `SELECT *
         FROM public.create_settlement_batch_v1($1::jsonb)
        LIMIT 1`,
      [JSON.stringify(input)],
    );
    return rows[0] || null;
  }

  async function recordFinanceEvent(input) {
    const { rows } = await client.query(
      `SELECT *
         FROM public.record_finance_event_v1($1::jsonb)
        LIMIT 1`,
      [JSON.stringify(input)],
    );
    return rows[0] || null;
  }

  async function attachFinanceEvent(input) {
    const { rows } = await client.query(
      `SELECT *
         FROM public.attach_finance_event_to_settlement_v1($1::jsonb)
        LIMIT 1`,
      [JSON.stringify(input)],
    );
    return rows[0] || null;
  }

  async function transitionSettlementBatch(settlementBatchId, toStatus, actorUserId, reason) {
    const { rows } = await client.query(
      `SELECT *
         FROM public.transition_settlement_batch_v1($1::jsonb)
        LIMIT 1`,
      [
        JSON.stringify({
          settlement_batch_id: settlementBatchId,
          to_status: toStatus,
          status_reason: reason,
          actor_user_id: actorUserId,
          actor_system: 'settlement_billing_payout_lifecycle_test',
          idempotency_key: `${settlementBatchId}-${toStatus}-${randomUUID()}`,
          payload: {
            source: 'settlement-billing-payout-lifecycle.test.js',
          },
        }),
      ],
    );
    return rows[0] || null;
  }

  async function fetchSettlementBatch(settlementBatchId) {
    const { rows } = await client.query(
      `SELECT
         id,
         organization_id,
         kind,
         scope_type,
         client_id,
         sender_id,
         subject_type,
         subject_id,
         status,
         status_reason,
         metadata,
         version
       FROM public.settlement_batches
      WHERE id = $1::uuid
      LIMIT 1`,
      [settlementBatchId],
    );
    return rows[0] || null;
  }

  async function fetchLifecycleRows(settlementBatchId) {
    const { rows } = await client.query(
      `SELECT
         sbfe.finance_event_id,
         fe.event_type,
         fe.direction,
         fe.amount,
         fe.currency,
         fe.account_type,
         fe.account_id,
         fe.subject_type,
         fe.subject_id,
         fe.metadata
       FROM public.settlement_batch_finance_events sbfe
       JOIN public.finance_events fe
         ON fe.id = sbfe.finance_event_id
        AND fe.organization_id = sbfe.organization_id
        AND fe.occurred_at = sbfe.finance_occurred_at
      WHERE sbfe.settlement_batch_id = $1::uuid
      ORDER BY fe.created_at ASC, fe.id ASC`,
      [settlementBatchId],
    );
    return rows;
  }

  async function fetchSettlementEvents(settlementBatchId) {
    const { rows } = await client.query(
      `SELECT
         event_type,
         from_status,
         to_status,
         batch_version,
         decision_log_id,
         settings_resolution_id,
         payload
       FROM public.settlement_events
      WHERE settlement_batch_id = $1::uuid
      ORDER BY batch_version ASC, created_at ASC, id ASC`,
      [settlementBatchId],
    );
    return rows;
  }

  async function fetchDecisionRows(settlementBatchId) {
    const { rows } = await client.query(
      `SELECT
         decision_point,
         decision_outcome,
         decision_inputs,
         settings_resolution_id
       FROM public.decision_log
      WHERE resource_type = 'settlement_batch'
        AND resource_id = $1::uuid
      ORDER BY timestamp ASC, id ASC`,
      [settlementBatchId],
    );
    return rows;
  }

  test('generic non-marketplace billing and payout batches post from finance-ledger membership', async () => {
    const organization = await createOrganization(client, 'Generic Billing Payout Org');
    const operatorUserId = await createUser(
      client,
      organization.id,
      `billing-payout-operator-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'ops_admin' },
    );
    const clientAccount = await createClient(client, organization.id, 'Generic Billing Client');
    const senderId = await createSender(client, clientAccount.id, 'Generic Billing Sender');
    const payoutCounterpartyId = randomUUID();
    const windowStartAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const windowEndAt = new Date().toISOString();

    await applySetting(client, {
      category: 'settlement_policy',
      scopeType: 'tenant',
      scopeId: organization.id,
      value: {
        version: 1,
        enabled: true,
        batch_scopes: ['client_cycle', 'accounting_period'],
        locking: {
          require_manager_approval: false,
          max_variance_amount: 0,
        },
      },
      changeReason: 'integration test seed: billing/payout settlement scopes',
    });

    await setServiceContext(organization.id, operatorUserId);

    await requireLookupValue('settlement_kind', 'billing');
    await requireLookupValue('settlement_kind', 'payout');
    await requireLookupValue('settlement_scope_type', 'client_cycle');
    await requireLookupValue('settlement_scope_type', 'accounting_period');
    await requireLookupValue('settlement_status', 'posted');
    await requireLookupValue('finance_event_type', 'charge');
    await requireLookupValue('finance_event_type', 'payout');

    const billingBatch = await createSettlementBatch({
      organization_id: organization.id,
      kind: 'billing',
      scope_type: 'client_cycle',
      client_id: clientAccount.id,
      sender_id: senderId,
      subject_type: 'client',
      subject_id: clientAccount.id,
      window_start_at: windowStartAt,
      window_end_at: windowEndAt,
      actor_user_id: operatorUserId,
      actor_system: 'settlement_billing_payout_lifecycle_test',
      idempotency_key: `billing-batch-${randomUUID()}`,
      metadata: {
        flow_id: 'biz_billing_and_payout_settlement_lifecycle',
        marketplace: false,
        settlement_surface: 'generic_billing',
      },
    });
    expect(billingBatch?.created).toBe(true);
    expect(billingBatch?.settlement_batch_id).toBeTruthy();

    const payoutBatch = await createSettlementBatch({
      organization_id: organization.id,
      kind: 'payout',
      scope_type: 'accounting_period',
      subject_type: 'external_counterparty',
      subject_id: payoutCounterpartyId,
      window_start_at: windowStartAt,
      window_end_at: windowEndAt,
      actor_user_id: operatorUserId,
      actor_system: 'settlement_billing_payout_lifecycle_test',
      idempotency_key: `payout-batch-${randomUUID()}`,
      metadata: {
        flow_id: 'biz_billing_and_payout_settlement_lifecycle',
        marketplace: false,
        settlement_surface: 'generic_payout',
      },
    });
    expect(payoutBatch?.created).toBe(true);
    expect(payoutBatch?.settlement_batch_id).toBeTruthy();

    const billingEventKey = `billing-charge-${randomUUID()}`;
    const billingFinanceEvent = await recordFinanceEvent({
      organization_id: organization.id,
      event_type: 'charge',
      direction: 'in',
      amount: 325.75,
      currency: 'SAR',
      account_type: 'client',
      account_id: clientAccount.id,
      subject_type: 'settlement_batch',
      subject_id: billingBatch.settlement_batch_id,
      idempotency_key: billingEventKey,
      metadata: {
        flow_id: 'biz_billing_and_payout_settlement_lifecycle',
        marketplace: false,
        billing_cycle: 'integration-cycle',
      },
    });
    expect(billingFinanceEvent?.created).toBe(true);

    const replayedBillingFinanceEvent = await recordFinanceEvent({
      organization_id: organization.id,
      event_type: 'charge',
      direction: 'in',
      amount: 325.75,
      currency: 'SAR',
      account_type: 'client',
      account_id: clientAccount.id,
      subject_type: 'settlement_batch',
      subject_id: billingBatch.settlement_batch_id,
      idempotency_key: billingEventKey,
    });
    expect(replayedBillingFinanceEvent).toMatchObject({
      finance_event_id: billingFinanceEvent.finance_event_id,
      created: false,
    });

    const payoutFinanceEvent = await recordFinanceEvent({
      organization_id: organization.id,
      event_type: 'payout',
      direction: 'out',
      amount: 125.25,
      currency: 'SAR',
      account_type: 'external',
      account_id: payoutCounterpartyId,
      subject_type: 'settlement_batch',
      subject_id: payoutBatch.settlement_batch_id,
      idempotency_key: `generic-payout-${randomUUID()}`,
      metadata: {
        flow_id: 'biz_billing_and_payout_settlement_lifecycle',
        marketplace: false,
        payout_channel: 'manual_export',
      },
    });
    expect(payoutFinanceEvent?.created).toBe(true);

    const billingAttachKey = `billing-attach-${randomUUID()}`;
    const billingAttach = await attachFinanceEvent({
      settlement_batch_id: billingBatch.settlement_batch_id,
      finance_event_id: billingFinanceEvent.finance_event_id,
      actor_user_id: operatorUserId,
      actor_system: 'settlement_billing_payout_lifecycle_test',
      idempotency_key: billingAttachKey,
      payload: {
        flow_id: 'biz_billing_and_payout_settlement_lifecycle',
        settlement_surface: 'generic_billing',
      },
    });
    expect(billingAttach).toMatchObject({
      settlement_batch_id: billingBatch.settlement_batch_id,
      attached: true,
    });

    const replayedBillingAttach = await attachFinanceEvent({
      settlement_batch_id: billingBatch.settlement_batch_id,
      finance_event_id: billingFinanceEvent.finance_event_id,
      actor_user_id: operatorUserId,
      actor_system: 'settlement_billing_payout_lifecycle_test',
      idempotency_key: billingAttachKey,
    });
    expect(replayedBillingAttach).toMatchObject({
      settlement_batch_id: billingBatch.settlement_batch_id,
      attached: true,
    });

    const payoutAttach = await attachFinanceEvent({
      settlement_batch_id: payoutBatch.settlement_batch_id,
      finance_event_id: payoutFinanceEvent.finance_event_id,
      actor_user_id: operatorUserId,
      actor_system: 'settlement_billing_payout_lifecycle_test',
      idempotency_key: `payout-attach-${randomUUID()}`,
      payload: {
        flow_id: 'biz_billing_and_payout_settlement_lifecycle',
        settlement_surface: 'generic_payout',
      },
    });
    expect(payoutAttach).toMatchObject({
      settlement_batch_id: payoutBatch.settlement_batch_id,
      attached: true,
    });

    for (const settlementBatchId of [
      billingBatch.settlement_batch_id,
      payoutBatch.settlement_batch_id,
    ]) {
      expect(
        await transitionSettlementBatch(
          settlementBatchId,
          'locked',
          operatorUserId,
          'membership_closed',
        ),
      ).toMatchObject({ settlement_batch_id: settlementBatchId });
      expect(
        await transitionSettlementBatch(
          settlementBatchId,
          'approved',
          operatorUserId,
          'finance_review_approved',
        ),
      ).toMatchObject({ settlement_batch_id: settlementBatchId });
      expect(
        await transitionSettlementBatch(
          settlementBatchId,
          'posted',
          operatorUserId,
          'accounting_exported',
        ),
      ).toMatchObject({ settlement_batch_id: settlementBatchId });
    }

    const postedBillingBatch = await fetchSettlementBatch(billingBatch.settlement_batch_id);
    expect(postedBillingBatch).toMatchObject({
      organization_id: organization.id,
      kind: 'billing',
      scope_type: 'client_cycle',
      client_id: clientAccount.id,
      sender_id: senderId,
      subject_type: 'client',
      subject_id: clientAccount.id,
      status: 'posted',
      status_reason: 'accounting_exported',
    });
    expect(postedBillingBatch.metadata).toMatchObject({
      flow_id: 'biz_billing_and_payout_settlement_lifecycle',
      marketplace: false,
      settlement_surface: 'generic_billing',
    });

    const postedPayoutBatch = await fetchSettlementBatch(payoutBatch.settlement_batch_id);
    expect(postedPayoutBatch).toMatchObject({
      organization_id: organization.id,
      kind: 'payout',
      scope_type: 'accounting_period',
      subject_type: 'external_counterparty',
      subject_id: payoutCounterpartyId,
      status: 'posted',
      status_reason: 'accounting_exported',
    });
    expect(postedPayoutBatch.metadata).toMatchObject({
      flow_id: 'biz_billing_and_payout_settlement_lifecycle',
      marketplace: false,
      settlement_surface: 'generic_payout',
    });

    const billingRows = await fetchLifecycleRows(billingBatch.settlement_batch_id);
    expect(billingRows).toHaveLength(1);
    expect(billingRows[0]).toMatchObject({
      finance_event_id: billingFinanceEvent.finance_event_id,
      event_type: 'charge',
      direction: 'in',
      amount: '325.75',
      currency: 'SAR',
      account_type: 'client',
      account_id: clientAccount.id,
      subject_type: 'settlement_batch',
      subject_id: billingBatch.settlement_batch_id,
    });
    expect(billingRows[0].metadata).toMatchObject({
      flow_id: 'biz_billing_and_payout_settlement_lifecycle',
      marketplace: false,
      billing_cycle: 'integration-cycle',
    });

    const payoutRows = await fetchLifecycleRows(payoutBatch.settlement_batch_id);
    expect(payoutRows).toHaveLength(1);
    expect(payoutRows[0]).toMatchObject({
      finance_event_id: payoutFinanceEvent.finance_event_id,
      event_type: 'payout',
      direction: 'out',
      amount: '125.25',
      currency: 'SAR',
      account_type: 'external',
      account_id: payoutCounterpartyId,
      subject_type: 'settlement_batch',
      subject_id: payoutBatch.settlement_batch_id,
    });
    expect(payoutRows[0].metadata).toMatchObject({
      flow_id: 'biz_billing_and_payout_settlement_lifecycle',
      marketplace: false,
      payout_channel: 'manual_export',
    });

    for (const settlementBatchId of [
      billingBatch.settlement_batch_id,
      payoutBatch.settlement_batch_id,
    ]) {
      const events = await fetchSettlementEvents(settlementBatchId);
      expect(events.map((row) => row.event_type)).toEqual([
        'created',
        'finance_event_attached',
        'status_changed',
        'status_changed',
        'status_changed',
      ]);
      expect(
        events
          .filter((row) => row.event_type === 'status_changed')
          .map((row) => row.to_status),
      ).toEqual(['locked', 'approved', 'posted']);
      expect(events.every((row) => row.decision_log_id)).toBe(true);
      expect(events.every((row) => row.settings_resolution_id)).toBe(true);
    }

    await setAuthContext(client, operatorUserId);
    const { rows: tenantVisibleRows } = await client.query(
      `SELECT kind, status
         FROM public.settlement_batches
        WHERE id = ANY($1::uuid[])
        ORDER BY kind ASC`,
      [[billingBatch.settlement_batch_id, payoutBatch.settlement_batch_id]],
    );
    expect(tenantVisibleRows).toEqual([
      { kind: 'billing', status: 'posted' },
      { kind: 'payout', status: 'posted' },
    ]);

    await setServiceContext(organization.id, operatorUserId);
    const outsiderOrganization = await createOrganization(client, 'Generic Billing Payout Outsider');
    const outsiderUserId = await createUser(
      client,
      outsiderOrganization.id,
      `billing-payout-outsider-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'ops_admin' },
    );

    await setAuthContext(client, outsiderUserId);
    const { rows: outsiderRows } = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM public.settlement_batches
        WHERE id = ANY($1::uuid[])`,
      [[billingBatch.settlement_batch_id, payoutBatch.settlement_batch_id]],
    );
    expect(outsiderRows[0]?.count).toBe(0);

    await setServiceContext(organization.id, operatorUserId);
    await expect(
      attachFinanceEvent({
        settlement_batch_id: billingBatch.settlement_batch_id,
        finance_event_id: payoutFinanceEvent.finance_event_id,
        actor_user_id: operatorUserId,
        actor_system: 'settlement_billing_payout_lifecycle_test',
        idempotency_key: `posted-attach-rejected-${randomUUID()}`,
      }),
    ).rejects.toThrow(/not allowed|status: posted/i);
  });

  test('discrepancy and breach branches stay policy-backed in the settlement ledger', async () => {
    const organization = await createOrganization(client, 'Billing Payout Branch Coverage Org');
    const operatorUserId = await createUser(
      client,
      organization.id,
      `billing-payout-branch-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'ops_admin' },
    );
    const clientAccount = await createClient(client, organization.id, 'Branch Coverage Client');
    const senderId = await createSender(client, clientAccount.id, 'Branch Coverage Sender');
    const payoutCounterpartyId = randomUUID();
    const windowStartAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const windowEndAt = new Date().toISOString();

    await applySetting(client, {
      category: 'settlement_policy',
      scopeType: 'tenant',
      scopeId: organization.id,
      value: {
        version: 1,
        enabled: true,
        batch_scopes: ['client_cycle', 'accounting_period'],
        locking: {
          require_manager_approval: true,
          max_variance_amount: 0,
        },
        discrepancy_branches: {
          pricing_dispute: {
            finance_event_type: 'adjustment',
            status_reason: 'discrepancy_resolved',
          },
        },
        breach_branches: {
          payout_sla_breach: {
            finance_event_type: 'fee',
            status_reason: 'breach_review_approved',
          },
        },
      },
      changeReason: 'integration test seed: billing/payout discrepancy and breach branches',
    });

    await setServiceContext(organization.id, operatorUserId);

    await requireLookupValue('settlement_kind', 'billing');
    await requireLookupValue('settlement_kind', 'payout');
    await requireLookupValue('settlement_scope_type', 'client_cycle');
    await requireLookupValue('settlement_scope_type', 'accounting_period');
    await requireLookupValue('settlement_status', 'locked');
    await requireLookupValue('settlement_status', 'approved');
    await requireLookupValue('settlement_status', 'posted');
    await requireLookupValue('finance_event_type', 'adjustment');
    await requireLookupValue('finance_event_type', 'fee');
    await requireLookupValue('finance_event_type', 'payout');
    await requireLookupValue('finance_direction', 'in');
    await requireLookupValue('finance_direction', 'out');

    const billingBatch = await createSettlementBatch({
      organization_id: organization.id,
      kind: 'billing',
      scope_type: 'client_cycle',
      client_id: clientAccount.id,
      sender_id: senderId,
      subject_type: 'client',
      subject_id: clientAccount.id,
      window_start_at: windowStartAt,
      window_end_at: windowEndAt,
      actor_user_id: operatorUserId,
      actor_system: 'settlement_billing_payout_lifecycle_test',
      idempotency_key: `billing-discrepancy-${randomUUID()}`,
      metadata: {
        flow_id: 'biz_billing_and_payout_settlement_lifecycle',
        marketplace: false,
        settlement_surface: 'generic_billing',
        branch: 'pricing_discrepancy',
      },
    });
    expect(billingBatch?.created).toBe(true);

    const payoutBatch = await createSettlementBatch({
      organization_id: organization.id,
      kind: 'payout',
      scope_type: 'accounting_period',
      subject_type: 'external_counterparty',
      subject_id: payoutCounterpartyId,
      window_start_at: windowStartAt,
      window_end_at: windowEndAt,
      actor_user_id: operatorUserId,
      actor_system: 'settlement_billing_payout_lifecycle_test',
      idempotency_key: `payout-breach-${randomUUID()}`,
      metadata: {
        flow_id: 'biz_billing_and_payout_settlement_lifecycle',
        marketplace: false,
        settlement_surface: 'generic_payout',
        branch: 'payout_sla_breach',
      },
    });
    expect(payoutBatch?.created).toBe(true);

    const billingDiscrepancyEvent = await recordFinanceEvent({
      organization_id: organization.id,
      event_type: 'adjustment',
      direction: 'out',
      amount: 42.5,
      currency: 'SAR',
      account_type: 'client',
      account_id: clientAccount.id,
      subject_type: 'settlement_batch',
      subject_id: billingBatch.settlement_batch_id,
      idempotency_key: `billing-discrepancy-adjustment-${randomUUID()}`,
      metadata: {
        flow_id: 'biz_billing_and_payout_settlement_lifecycle',
        marketplace: false,
        branch: 'pricing_discrepancy',
        discrepancy: {
          kind: 'pricing_dispute',
          policy_key: 'discrepancy_branches.pricing_dispute',
          resolution: 'client_credit_adjustment',
        },
      },
    });
    expect(billingDiscrepancyEvent?.created).toBe(true);

    const payoutFinanceEvent = await recordFinanceEvent({
      organization_id: organization.id,
      event_type: 'payout',
      direction: 'out',
      amount: 175,
      currency: 'SAR',
      account_type: 'external',
      account_id: payoutCounterpartyId,
      subject_type: 'settlement_batch',
      subject_id: payoutBatch.settlement_batch_id,
      idempotency_key: `payout-breach-base-${randomUUID()}`,
      metadata: {
        flow_id: 'biz_billing_and_payout_settlement_lifecycle',
        marketplace: false,
        branch: 'payout_sla_breach',
      },
    });
    expect(payoutFinanceEvent?.created).toBe(true);

    const payoutBreachEvent = await recordFinanceEvent({
      organization_id: organization.id,
      event_type: 'fee',
      direction: 'in',
      amount: 15,
      currency: 'SAR',
      account_type: 'external',
      account_id: payoutCounterpartyId,
      subject_type: 'settlement_batch',
      subject_id: payoutBatch.settlement_batch_id,
      idempotency_key: `payout-breach-fee-${randomUUID()}`,
      metadata: {
        flow_id: 'biz_billing_and_payout_settlement_lifecycle',
        marketplace: false,
        branch: 'payout_sla_breach',
        breach: {
          kind: 'sla_breach',
          policy_key: 'breach_branches.payout_sla_breach',
          resolution: 'payout_penalty_applied',
        },
      },
    });
    expect(payoutBreachEvent?.created).toBe(true);

    await expect(
      attachFinanceEvent({
        settlement_batch_id: billingBatch.settlement_batch_id,
        finance_event_id: billingDiscrepancyEvent.finance_event_id,
        actor_user_id: operatorUserId,
        actor_system: 'settlement_billing_payout_lifecycle_test',
        idempotency_key: `billing-discrepancy-attach-${randomUUID()}`,
        payload: {
          branch: 'pricing_discrepancy',
          discrepancy_kind: 'pricing_dispute',
        },
      }),
    ).resolves.toMatchObject({
      settlement_batch_id: billingBatch.settlement_batch_id,
      attached: true,
    });

    for (const [financeEventId, branch] of [
      [payoutFinanceEvent.finance_event_id, 'base_payout'],
      [payoutBreachEvent.finance_event_id, 'payout_sla_breach'],
    ]) {
      await expect(
        attachFinanceEvent({
          settlement_batch_id: payoutBatch.settlement_batch_id,
          finance_event_id: financeEventId,
          actor_user_id: operatorUserId,
          actor_system: 'settlement_billing_payout_lifecycle_test',
          idempotency_key: `payout-breach-attach-${branch}-${randomUUID()}`,
          payload: { branch },
        }),
      ).resolves.toMatchObject({
        settlement_batch_id: payoutBatch.settlement_batch_id,
        attached: true,
      });
    }

    await transitionSettlementBatch(
      billingBatch.settlement_batch_id,
      'locked',
      operatorUserId,
      'discrepancy_resolved',
    );
    await transitionSettlementBatch(
      billingBatch.settlement_batch_id,
      'approved',
      operatorUserId,
      'discrepancy_credit_approved',
    );
    await transitionSettlementBatch(
      billingBatch.settlement_batch_id,
      'posted',
      operatorUserId,
      'invoice_exported_after_discrepancy',
    );

    await transitionSettlementBatch(
      payoutBatch.settlement_batch_id,
      'locked',
      operatorUserId,
      'breach_review_approved',
    );
    await transitionSettlementBatch(
      payoutBatch.settlement_batch_id,
      'approved',
      operatorUserId,
      'breach_penalty_approved',
    );
    await transitionSettlementBatch(
      payoutBatch.settlement_batch_id,
      'posted',
      operatorUserId,
      'payout_exported_after_breach_adjustment',
    );

    const postedBillingBatch = await fetchSettlementBatch(billingBatch.settlement_batch_id);
    expect(postedBillingBatch).toMatchObject({
      kind: 'billing',
      status: 'posted',
      status_reason: 'invoice_exported_after_discrepancy',
    });
    expect(postedBillingBatch.metadata).toMatchObject({
      flow_id: 'biz_billing_and_payout_settlement_lifecycle',
      branch: 'pricing_discrepancy',
    });

    const postedPayoutBatch = await fetchSettlementBatch(payoutBatch.settlement_batch_id);
    expect(postedPayoutBatch).toMatchObject({
      kind: 'payout',
      status: 'posted',
      status_reason: 'payout_exported_after_breach_adjustment',
    });
    expect(postedPayoutBatch.metadata).toMatchObject({
      flow_id: 'biz_billing_and_payout_settlement_lifecycle',
      branch: 'payout_sla_breach',
    });

    const billingRows = await fetchLifecycleRows(billingBatch.settlement_batch_id);
    expect(billingRows).toHaveLength(1);
    expect(billingRows[0]).toMatchObject({
      event_type: 'adjustment',
      direction: 'out',
      currency: 'SAR',
      account_type: 'client',
      account_id: clientAccount.id,
    });
    expect(Number(billingRows[0].amount)).toBe(42.5);
    expect(billingRows[0].metadata).toMatchObject({
      branch: 'pricing_discrepancy',
      discrepancy: {
        kind: 'pricing_dispute',
        policy_key: 'discrepancy_branches.pricing_dispute',
      },
    });

    const payoutRows = await fetchLifecycleRows(payoutBatch.settlement_batch_id);
    expect(payoutRows.map((row) => row.event_type).sort()).toEqual(['fee', 'payout']);
    const payoutBreachRow = payoutRows.find((row) => row.event_type === 'fee');
    expect(payoutBreachRow).toMatchObject({
      direction: 'in',
      currency: 'SAR',
      account_type: 'external',
      account_id: payoutCounterpartyId,
    });
    expect(Number(payoutBreachRow?.amount)).toBe(15);
    expect(payoutBreachRow?.metadata).toMatchObject({
      branch: 'payout_sla_breach',
      breach: {
        kind: 'sla_breach',
        policy_key: 'breach_branches.payout_sla_breach',
      },
    });

    const billingEvents = await fetchSettlementEvents(billingBatch.settlement_batch_id);
    expect(
      billingEvents
        .filter((row) => row.event_type === 'status_changed')
        .map((row) => row.to_status),
    ).toEqual(['locked', 'approved', 'posted']);
    expect(billingEvents.every((row) => row.decision_log_id)).toBe(true);
    expect(billingEvents.every((row) => row.settings_resolution_id)).toBe(true);

    const payoutEvents = await fetchSettlementEvents(payoutBatch.settlement_batch_id);
    expect(payoutEvents.map((row) => row.event_type)).toEqual([
      'created',
      'finance_event_attached',
      'finance_event_attached',
      'status_changed',
      'status_changed',
      'status_changed',
    ]);
    expect(payoutEvents.every((row) => row.decision_log_id)).toBe(true);
    expect(payoutEvents.every((row) => row.settings_resolution_id)).toBe(true);

    for (const settlementBatchId of [
      billingBatch.settlement_batch_id,
      payoutBatch.settlement_batch_id,
    ]) {
      const decisions = await fetchDecisionRows(settlementBatchId);
      expect(decisions.map((row) => row.decision_point)).toEqual(
        expect.arrayContaining(['create', 'attach_finance_event', 'transition']),
      );
      expect(decisions.every((row) => row.settings_resolution_id)).toBe(true);
    }
  });
});
