async function rpcOne(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows[0] || null;
}

async function getShipment(client, trackingNumber) {
  const row = await rpcOne(
    client,
    `
      select
        s.id,
        s.organization_id,
        s.client_id,
        s.sender_id,
        s.tracking_number,
        right(regexp_replace(coalesce(r.phone_number, ''), '[^0-9]', '', 'g'), 3) as phone_last3,
        addr.raw_input as shipment_address_text,
        addr.sa_short_code as shipment_short_national_address
      from public.shipments s
      left join public.recipients r on r.id = s.recipient_id
      left join public.addresses addr on addr.id = s.destination_address_id
      where s.tracking_number = $1
      limit 1
    `,
    [trackingNumber]
  );

  if (!row) throw new Error(`shipment not found: ${trackingNumber}`);
  return row;
}

async function verifySession(client, reference, phoneLast3, ipHash) {
  const row = await rpcOne(
    client,
    `
      select public.public_tracking_verify_v1(
        jsonb_build_object(
          'reference', $1::text,
          'phone_last3', $2::text,
          'ip_hash', $3::text
        )
      ) as data
    `,
    [reference, phoneLast3, ipHash]
  );
  const payload = row?.data || {};
  if (payload.ok !== true || !payload.session_token) {
    throw new Error(`verify failed for ${reference}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function submitRequest(client, sessionToken, ipHash, requestType, payload) {
  const row = await rpcOne(
    client,
    `
      select public.public_tracking_submit_request_v2(
        jsonb_build_object(
          'session_token', $1::text,
          'ip_hash', $2::text,
          'request_type', $3::text,
          'payload', $4::jsonb
        )
      ) as data
    `,
    [sessionToken, ipHash, requestType, JSON.stringify(payload)]
  );
  return row?.data || {};
}

async function setLocationChangeExecutionMode(client, shipment, executionMode, reason) {
  await client.query(
    `
      select public.upsert_settings_value_v1(
        'public_tracking_policy',
        'sender',
        $1::uuid,
        public.deep_merge_jsonb(
          public.public_tracking_policy_v1(
            jsonb_build_object(
              'organization_id', $2::uuid,
              'client_id', $3::uuid,
              'sender_id', $1::uuid
            )
          ),
          jsonb_build_object(
            'actions',
            jsonb_build_object(
              'location_change',
              jsonb_build_object('execution_mode', $4::text)
            )
          )
        ),
        1,
        $5::text
      )
    `,
    [shipment.sender_id, shipment.organization_id, shipment.client_id, executionMode, reason]
  );
}

async function setReviewRequiredPolicy(client, shipment) {
  await setLocationChangeExecutionMode(
    client,
    shipment,
    'review_required',
    'qa customer shipment change requester fixtures'
  );
}

async function restoreDefaultPolicy(client, shipment) {
  await setLocationChangeExecutionMode(
    client,
    shipment,
    'auto_apply_with_fallback_to_review',
    'restore public tracking location change execution mode after qa fixtures'
  );
}

async function fetchCaseSummary(client, supportCaseId) {
  if (!supportCaseId) {
    throw new Error('support_case_id is required to fetch case summary');
  }
  const row = await rpcOne(
    client,
    `
      select
        sc.id,
        sc.status,
        sc.status_reason,
        sc.request_type_key,
        sc.request_outcome,
        sc.tracking_number,
        sc.change_summary,
        sc.changed_fields,
        sc.metadata #> array['review_task'] as review_task
      from public.support_cases sc
      where sc.id = $1::uuid
      limit 1
    `,
    [supportCaseId]
  );

  const notifications = await client.query(
    `
      select body->>'stage' as stage
      from public.outbound_calls
      where context->>'support_case_id' = $1::text
      order by created_at asc
    `,
    [supportCaseId]
  );

  const tasks = await client.query(
    `
      select id
      from public.tasks
      where resource_type = 'support_case'
        and resource_id = $1::uuid
      order by created_at desc
    `,
    [supportCaseId]
  );

  return {
    ...row,
    notification_stages: notifications.rows.map((entry) => entry.stage),
    task_ids: tasks.rows.map((entry) => entry.id),
  };
}

async function withCustomerShipmentChangeFixtureLock(client, fn) {
  const lockKey = 'qa:customer-shipment-change-fixtures';
  await client.query(`select pg_advisory_lock(hashtextextended($1::text, 0))`, [lockKey]);
  try {
    return await fn();
  } finally {
    await client.query(`select pg_advisory_unlock(hashtextextended($1::text, 0))`, [lockKey]);
  }
}

module.exports = {
  fetchCaseSummary,
  getShipment,
  restoreDefaultPolicy,
  rpcOne,
  setReviewRequiredPolicy,
  submitRequest,
  verifySession,
  withCustomerShipmentChangeFixtureLock,
};
