const { requireEnv } = require('../../utils/test-env');

const parseJsonSafe = async (response) => {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

const expectSchemaDenied = async (response, schema) => {
  const body = await parseJsonSafe(response);
  if (response.status === 401 && body?.code === 'PGRST301') {
    const error = new Error('prerequisite_blocked: api_schema_auth_mismatch');
    error.code = 'INTEGRATION_PREREQUISITE_BLOCKED';
    error.prerequisite = 'api_schema_auth_mismatch';
    throw error;
  }

  expect(response.status).toBe(406);
  expect(body.code).toBe('PGRST106');
  expect(body.message).toBe(`Invalid schema: ${schema}`);
};

describe('API schema boundary (PostgREST exposure)', () => {
  const missing = requireEnv(['SUPABASE_URL', 'SUPABASE_ANON_KEY'], 'api schema boundary');

  (missing ? test.skip : test)('public schema is not exposed (PGRST106)', async () => {
    const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/g, '');
    const anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();

    const res = await fetch(`${baseUrl}/rest/v1/spatial_ref_sys?select=srid&limit=1`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Accept-Profile': 'public',
        'Content-Profile': 'public',
      },
    });

    await expectSchemaDenied(res, 'public');
  });

  (missing ? test.skip : test)('qa schema is not exposed (PGRST106)', async () => {
    const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/g, '');
    const anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();

    const res = await fetch(`${baseUrl}/rest/v1/spatial_ref_sys?select=srid&limit=1`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Accept-Profile': 'qa',
        'Content-Profile': 'qa',
      },
    });

    await expectSchemaDenied(res, 'qa');
  });

  (missing ? test.skip : test)('graphql_public schema is not exposed (PGRST106)', async () => {
    const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/g, '');
    const anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();

    const res = await fetch(`${baseUrl}/rest/v1/spatial_ref_sys?select=srid&limit=1`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Accept-Profile': 'graphql_public',
        'Content-Profile': 'graphql_public',
      },
    });

    await expectSchemaDenied(res, 'graphql_public');
  });
});
