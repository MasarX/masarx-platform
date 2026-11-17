const { requireEnv } = require('../../utils/test-env');

describe('GraphQL API boundary', () => {
  const missing = requireEnv(['SUPABASE_URL', 'SUPABASE_ANON_KEY'], 'graphql api boundary');

  (missing ? test.skip : test)('GraphQL endpoint is disabled', async () => {
    const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/g, '');
    const anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();

    const res = await fetch(`${baseUrl}/graphql/v1`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: 'query { __schema { queryType { name } } }' }),
    });

    if (res.status === 200) {
      throw new Error(
        [
          'GraphQL is enabled for this project.',
          'Disable Supabase GraphQL (remove `graphql_public` from exposed schemas and/or disable GraphQL in the Supabase Dashboard) to prevent automatic surfacing of `public` tables like `spatial_ref_sys`.',
        ].join(' ')
      );
    }
  });
});
