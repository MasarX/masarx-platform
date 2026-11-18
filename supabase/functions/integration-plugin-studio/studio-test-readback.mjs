// Existing authenticated Studio handler calls this for action=test_status.
// Never forward registry rows: they can contain raw payloads and credentials.
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fail = () => { throw Object.assign(new Error('studio.test.readback_unavailable'), { status: 400, code: 'studio.test.readback_unavailable' }); };
export async function readStudioTest({ body, userClient }) {
  try {
  if (!uuid(body.source_id) || !uuid(body.external_id)) fail();
  const eligibility = await userClient.rpc('ui_integration_studio_test_readback_v1', {
    p_source_id: body.source_id, p_external_id: body.external_id, p_inbox_id: null,
  });
  if (eligibility.error || eligibility.data?.state !== 'pending'
      || eligibility.data.source_id !== body.source_id || eligibility.data.external_id !== body.external_id) fail();
  const { data: rows, error } = await userClient.rpc('ui_list_resource_v1', {
    p_resource: 'webhook_inbox', p_filters: { webhook_source_id: body.source_id, external_id: body.external_id },
    p_limit: 2, p_offset: 0, p_sort: null,
  });
  if (error || !Array.isArray(rows?.items) || rows.items.length > 1) fail();
  if (!rows.items.length) return { state: 'pending', source_id: body.source_id, external_id: body.external_id };
  const inbox = rows.items[0];
  if (!uuid(inbox.id) || inbox.webhook_source_id !== body.source_id || inbox.external_id !== body.external_id) fail();
  const result = await userClient.rpc('ui_integration_studio_test_readback_v1', {
    p_source_id: body.source_id, p_external_id: body.external_id, p_inbox_id: inbox.id,
  });
  const data = result.data;
  if (result.error || !data || !['pending','failed','succeeded'].includes(data.state)
      || data.source_id !== body.source_id || data.external_id !== body.external_id || data.inbox_id !== inbox.id
      || (data.state === 'succeeded' && (!uuid(data.shipment_id) || !uuid(data.workflow_run_id) || !uuid(data.workflow_run_step_id)))
      || !Array.isArray(data.decision_log_ids) || !data.decision_log_ids.every(uuid)
      || (data.state === 'succeeded' && data.decision_log_ids.length===0)) fail();
  return { state: data.state, source_id: body.source_id, external_id: body.external_id, inbox_id: inbox.id,
    shipment_id: uuid(data.shipment_id) ? data.shipment_id : null,
    workflow_run_id: uuid(data.workflow_run_id) ? data.workflow_run_id : null,
    workflow_run_step_id: uuid(data.workflow_run_step_id) ? data.workflow_run_step_id : null,
    decision_log_ids: data.decision_log_ids };
  } catch { fail(); }
}
