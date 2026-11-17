const { Client } = require('pg');
const { loadEnv } = require('../utils/load-env');
loadEnv();

(async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  const sql = 'SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS response';
  const params = [
    'token-webhook-test',
    JSON.stringify({ 'content-type': 'application/json' }),
    JSON.stringify({ example: 'value' }),
    JSON.stringify({ example: 'value' })
  ];
  const { rows } = await client.query(sql, params);
  console.log(JSON.stringify(rows[0].response, null, 2));
  await client.end();
})();
