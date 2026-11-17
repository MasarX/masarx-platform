const crypto = require('crypto');

const headersJson = JSON.stringify({
  'content-type': 'application/json',
});

function buildPayload(overrides = {}) {
  const base = {
    event: {
      id: `evt-${crypto.randomUUID()}`,
      type: 'shipment.created',
    },
    shipment: {
      tracking_number: `TRACK-${Math.floor(Math.random() * 1_000_000)}`,
      status: 'created',
      delivered_at: null,
      customer: {
        name: 'Workflow Intake Test Customer',
        phone: '+12025550123',
      },
    },
  };
  return {
    ...base,
    ...overrides,
  };
}

async function callWorkflowIntake(runner, token, payload) {
  const payloadJson = JSON.stringify(payload);
  const { rows } = await runner.query(
    `SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS response`,
    [token, headersJson, payloadJson, payloadJson]
  );
  return rows[0]?.response || null;
}

async function resolveWebhookSourceIdByToken(runner, token) {
  const { rows } = await runner.query(
    `SELECT id
       FROM get_webhook_source_by_token($1::text)
      LIMIT 1`,
    [token]
  );
  return rows[0]?.id || null;
}

module.exports = {
  headersJson,
  buildPayload,
  callWorkflowIntake,
  resolveWebhookSourceIdByToken,
};
