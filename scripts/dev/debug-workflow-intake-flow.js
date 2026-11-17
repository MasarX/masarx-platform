const { Client } = require('pg');
const { loadEnv } = require('../utils/load-env');
loadEnv();

const seedSql = ;

(async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  await client.query('BEGIN');
  await client.query(seedSql);
  const sql = 'SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS response';
  const params = [
    'token-webhook-test',
    JSON.stringify({ 'content-type': 'application/json' }),
    JSON.stringify({ example: 'value' }),
    JSON.stringify({ example: 'value' })
  ];
  const { rows } = await client.query(sql, params);
  console.log('response', rows[0].response);

  const webhookId = rows[0].response.webhook_id;
  console.log('workflow_inbox row', (await client.query('SELECT workflow_run_id, processing_status FROM webhook_inbox WHERE id = ', [webhookId])).rows);
  console.log('response history', (await client.query('SELECT http_status_code, response_outcome FROM webhook_response_events WHERE webhook_inbox_id =  ORDER BY response_created_at DESC', [webhookId])).rows);
  await client.query('ROLLBACK');
  await client.end();
})();
