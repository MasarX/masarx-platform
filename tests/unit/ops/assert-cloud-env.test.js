const {
  isSelectedDbHostFallback,
  validateCloudEnv,
} = require('../../../scripts/ops/assert-cloud-env');

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function makeJwt(payload) {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;
}

function baseEnv(overrides = {}) {
  return {
    DATABASE_URL: (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres'].join("")),
    EDGE_INTERNAL_CALLER_ROLES:
      'edge_api_gateway_role,edge_webhook_role,edge_api_caller_role,service_role',
    GITHUB_ACTIONS: 'false',
    ...overrides,
  };
}

function guardedEgressProofEnv(overrides = {}) {
  return {
    API_CALLER_GUARDED_EGRESS_PROOF_REQUIRED: '1',
    API_CALLER_GUARDED_EGRESS_PROOF_LANE: 'db-dev',
    API_CALLER_GUARDED_EGRESS_PROOF_SHA: '0123456789abcdef0123456789abcdef01234567',
    API_CALLER_GUARDED_EGRESS_PROXY_URL: 'https://proxy.example.test',
    API_CALLER_GUARDED_EGRESS_PROXY_USERNAME: 'api-caller',
    API_CALLER_GUARDED_EGRESS_PROXY_PASSWORD: 'proxy-password',
    API_CALLER_GUARDED_EGRESS_PROXY_HEALTH_URL: 'https://proxy.example.test/healthz',
    API_CALLER_GUARDED_EGRESS_PUBLIC_PROBE_URL: 'https://probe.example.test/egress-ip',
    API_CALLER_GUARDED_EGRESS_EXPECTED_PUBLIC_IP: '8.8.8.8',
    API_CALLER_GUARDED_EGRESS_POLICY_DENIED_PROBE_URL: 'https://192.0.2.10',
    API_CALLER_GUARDED_EGRESS_REBINDING_PROBE_URL: 'https://rebinding-probe.example.test',
    API_CALLER_GUARDED_EGRESS_POLICY_DENIED_CODE: 'NON_PUBLIC_DESTINATION_DENIED',
    ...overrides,
  };
}

describe('assert-cloud-env', () => {
  test('non-preview requires EDGE_REQUIRE_DB_JWT=1', () => {
    expect(() => validateCloudEnv({ env: baseEnv() })).toThrow(/EDGE_REQUIRE_DB_JWT must be set to 1/i);
  });

  test('non-preview passes when EDGE_REQUIRE_DB_JWT=1 and DB JWTs have expected roles', () => {
    expect(() =>
      validateCloudEnv({
        env: baseEnv({
          EDGE_REQUIRE_DB_JWT: '1',
          API_GATEWAY_DB_JWT: makeJwt({ role: 'edge_api_gateway_role' }),
          WEBHOOK_DB_JWT: makeJwt({ role: 'edge_webhook_role' }),
          API_CALLER_DB_JWT: makeJwt({ role: 'edge_api_caller_role' }),
          LABEL_RENDERER_DB_JWT: makeJwt({ role: 'edge_label_renderer_role' }),
        }),
      }),
    ).not.toThrow();
  });

  test('guarded egress proof requirement fails closed on missing lane configuration', () => {
    expect(() => validateCloudEnv({
      env: baseEnv({
        EDGE_REQUIRE_DB_JWT: '1',
        API_GATEWAY_DB_JWT: makeJwt({ role: 'edge_api_gateway_role' }),
        WEBHOOK_DB_JWT: makeJwt({ role: 'edge_webhook_role' }),
        API_CALLER_DB_JWT: makeJwt({ role: 'edge_api_caller_role' }),
        LABEL_RENDERER_DB_JWT: makeJwt({ role: 'edge_label_renderer_role' }),
        API_CALLER_GUARDED_EGRESS_PROOF_REQUIRED: '1',
        API_CALLER_GUARDED_EGRESS_PROOF_LANE: 'db-dev',
      }),
    })).toThrow(/API_CALLER_GUARDED_EGRESS_(?:PROOF_SHA|PROXY_URL)/);
  });

  test('guarded egress proof requirement accepts the complete exact lane configuration', () => {
    expect(() => validateCloudEnv({
      env: baseEnv({
        EDGE_REQUIRE_DB_JWT: '1',
        API_GATEWAY_DB_JWT: makeJwt({ role: 'edge_api_gateway_role' }),
        WEBHOOK_DB_JWT: makeJwt({ role: 'edge_webhook_role' }),
        API_CALLER_DB_JWT: makeJwt({ role: 'edge_api_caller_role' }),
        LABEL_RENDERER_DB_JWT: makeJwt({ role: 'edge_label_renderer_role' }),
        ...guardedEgressProofEnv(),
      }),
    })).not.toThrow();
  });

  test('non-preview rejects service_role DB JWTs for gateway/webhook/api-caller', () => {
    expect(() =>
      validateCloudEnv({
        env: baseEnv({
          EDGE_REQUIRE_DB_JWT: '1',
          API_GATEWAY_DB_JWT: makeJwt({ role: 'service_role' }),
          WEBHOOK_DB_JWT: makeJwt({ role: 'service_role' }),
          API_CALLER_DB_JWT: makeJwt({ role: 'service_role' }),
          LABEL_RENDERER_DB_JWT: makeJwt({ role: 'edge_label_renderer_role' }),
        }),
      }),
    ).toThrow(/API_GATEWAY_DB_JWT must have role=edge_api_gateway_role; got role=service_role/i);
  });

  test('non-preview rejects service_role LABEL_RENDERER_DB_JWT even when service_role is allowed internally', () => {
    expect(() =>
      validateCloudEnv({
        env: baseEnv({
          EDGE_REQUIRE_DB_JWT: '1',
          API_GATEWAY_DB_JWT: makeJwt({ role: 'edge_api_gateway_role' }),
          WEBHOOK_DB_JWT: makeJwt({ role: 'edge_webhook_role' }),
          API_CALLER_DB_JWT: makeJwt({ role: 'edge_api_caller_role' }),
          LABEL_RENDERER_DB_JWT: makeJwt({ role: 'service_role' }),
        }),
      }),
    ).toThrow(/LABEL_RENDERER_DB_JWT must have role=edge_label_renderer_role; got role=service_role/i);
  });

  test('non-preview rejects unsupported label fallback override variable', () => {
    expect(() =>
      validateCloudEnv({
        env: baseEnv({
          EDGE_REQUIRE_DB_JWT: '1',
          LABEL_RENDERER_DB_JWT_ALLOW_SERVICE_ROLE_FALLBACK: '1',
          API_GATEWAY_DB_JWT: makeJwt({ role: 'edge_api_gateway_role' }),
          WEBHOOK_DB_JWT: makeJwt({ role: 'edge_webhook_role' }),
          API_CALLER_DB_JWT: makeJwt({ role: 'edge_api_caller_role' }),
          LABEL_RENDERER_DB_JWT: makeJwt({ role: 'edge_label_renderer_role' }),
        }),
      }),
    ).toThrow(/LABEL_RENDERER_DB_JWT_ALLOW_SERVICE_ROLE_FALLBACK is not supported/i);
  });

  test('non-preview rejects service_role DB JWTs when service_role is not allowed internally', () => {
    expect(() =>
      validateCloudEnv({
        env: baseEnv({
          EDGE_INTERNAL_CALLER_ROLES: 'edge_api_gateway_role,edge_webhook_role,edge_api_caller_role',
          EDGE_REQUIRE_DB_JWT: '1',
          API_GATEWAY_DB_JWT: makeJwt({ role: 'service_role' }),
          WEBHOOK_DB_JWT: makeJwt({ role: 'service_role' }),
          API_CALLER_DB_JWT: makeJwt({ role: 'service_role' }),
          LABEL_RENDERER_DB_JWT: makeJwt({ role: 'service_role' }),
        }),
      }),
    ).toThrow(/must have role=edge_api_gateway_role; got role=service_role/i);
  });

  test('preview allows EDGE_REQUIRE_DB_JWT=0 without DB JWTs', () => {
    const res = validateCloudEnv({
      env: baseEnv({
        PREVIEW_SUPABASE_ACCESS_TOKEN: 'EXAMPLE_PASSWORD',
        EDGE_REQUIRE_DB_JWT: '0',
      }),
    });
    expect(res.preview).toBe(true);
    expect(res.edgeRequireDbJwt).toBe('0');
  });

  test('preview rejects invalid EDGE_REQUIRE_DB_JWT values', () => {
    expect(() =>
      validateCloudEnv({
        env: baseEnv({
          PREVIEW_SUPABASE_ACCESS_TOKEN: 'EXAMPLE_PASSWORD',
          EDGE_REQUIRE_DB_JWT: '2',
        }),
      }),
    ).toThrow(/EDGE_REQUIRE_DB_JWT must be 0 or 1 for preview environments/i);
  });

  test('preview with EDGE_REQUIRE_DB_JWT=1 still requires per-function DB JWTs', () => {
    expect(() =>
      validateCloudEnv({
        env: baseEnv({
          PREVIEW_SUPABASE_ACCESS_TOKEN: 'EXAMPLE_PASSWORD',
          EDGE_REQUIRE_DB_JWT: '1',
        }),
      }),
    ).toThrow(/Missing required environment variable: API_GATEWAY_DB_JWT/);
  });

  test('rejects non-supabase DATABASE_URL host when db-smoke fallback is not selected', () => {
    expect(() =>
      validateCloudEnv({
        env: baseEnv({
          DATABASE_URL: (['postgresql',":","/","/",'postgres',":",'pass',"@",'192.0.2.10',":",'5432',"/",'postgres'].join("")),
          EDGE_REQUIRE_DB_JWT: '1',
          API_GATEWAY_DB_JWT: makeJwt({ role: 'edge_api_gateway_role' }),
          WEBHOOK_DB_JWT: makeJwt({ role: 'edge_webhook_role' }),
          API_CALLER_DB_JWT: makeJwt({ role: 'edge_api_caller_role' }),
          LABEL_RENDERER_DB_JWT: makeJwt({ role: 'edge_label_renderer_role' }),
        }),
      }),
    ).toThrow(/DATABASE_URL host must end with \.supabase\.co or \.supabase\.com/i);
  });

  test('allows db-smoke ipv4host fallback when canonical direct/pooler DSN remains supabase', () => {
    expect(() =>
      validateCloudEnv({
        env: baseEnv({
          DATABASE_URL: (['postgresql',":","/","/",'postgres',":",'pass',"@",'192.0.2.10',":",'5432',"/",'postgres'].join("")),
          DATABASE_URL_DIRECT: (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres'].join("")),
          DB_SMOKE_SELECTED_DSN_NAME: 'DATABASE_URL+ipv4host',
          EDGE_REQUIRE_DB_JWT: '1',
          API_GATEWAY_DB_JWT: makeJwt({ role: 'edge_api_gateway_role' }),
          WEBHOOK_DB_JWT: makeJwt({ role: 'edge_webhook_role' }),
          API_CALLER_DB_JWT: makeJwt({ role: 'edge_api_caller_role' }),
          LABEL_RENDERER_DB_JWT: makeJwt({ role: 'edge_label_renderer_role' }),
        }),
      }),
    ).not.toThrow();
  });

  test('allows explicitly selected preview ipv4 fallback when canonical direct/pooler DSN remains supabase', () => {
    expect(() =>
      validateCloudEnv({
        env: baseEnv({
          DATABASE_URL: (['postgresql',":","/","/",'postgres',":",'pass',"@",'192.0.2.10',":",'5432',"/",'postgres'].join("")),
          DATABASE_URL_DIRECT: (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres'].join("")),
          DATABASE_URL_POOLER:
            (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'fake-db-password',"@",'aws-1-us-east-1.pooler.supabase.com',":",'5432',"/",'postgres'].join("")),
          DATABASE_URL_SELECTED_DSN_NAME: 'DATABASE_URL_POOLER+ipv4host',
          EDGE_REQUIRE_DB_JWT: '1',
          API_GATEWAY_DB_JWT: makeJwt({ role: 'edge_api_gateway_role' }),
          WEBHOOK_DB_JWT: makeJwt({ role: 'edge_webhook_role' }),
          API_CALLER_DB_JWT: makeJwt({ role: 'edge_api_caller_role' }),
          LABEL_RENDERER_DB_JWT: makeJwt({ role: 'edge_label_renderer_role' }),
        }),
      }),
    ).not.toThrow();
  });

  test('recognizes hostaddr fallback on selected preview DATABASE_URL', () => {
    expect(
      isSelectedDbHostFallback(
        {
          DATABASE_URL:
            (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres',"?",'hostaddr=192.0.2.10'].join("")),
        },
        (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres',"?",'hostaddr=192.0.2.10'].join("")),
      ),
    ).toBe(true);
  });

  test('rejects db-smoke fallback when canonical DSN proof is missing', () => {
    expect(() =>
      validateCloudEnv({
        env: baseEnv({
          DATABASE_URL: (['postgresql',":","/","/",'postgres',":",'pass',"@",'192.0.2.10',":",'5432',"/",'postgres'].join("")),
          DB_SMOKE_SELECTED_DSN_NAME: 'DATABASE_URL+ipv4host',
          EDGE_REQUIRE_DB_JWT: '1',
          API_GATEWAY_DB_JWT: makeJwt({ role: 'edge_api_gateway_role' }),
          WEBHOOK_DB_JWT: makeJwt({ role: 'edge_webhook_role' }),
          API_CALLER_DB_JWT: makeJwt({ role: 'edge_api_caller_role' }),
          LABEL_RENDERER_DB_JWT: makeJwt({ role: 'edge_label_renderer_role' }),
        }),
      }),
    ).toThrow(/DATABASE_URL host must end with \.supabase\.co or \.supabase\.com/i);
  });

  test('rejects custom SUPABASE_URL host unless explicitly allowed', () => {
    expect(() =>
      validateCloudEnv({
        env: baseEnv({
          DATABASE_URL: (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres'].join("")),
          SUPABASE_PROJECT_ID: 'abcdefghijklmnopqrst',
          SUPABASE_URL: 'https://fake-api.example.invalid',
          EDGE_REQUIRE_DB_JWT: '1',
          API_GATEWAY_DB_JWT: makeJwt({ role: 'edge_api_gateway_role' }),
          WEBHOOK_DB_JWT: makeJwt({ role: 'edge_webhook_role' }),
          API_CALLER_DB_JWT: makeJwt({ role: 'edge_api_caller_role' }),
          LABEL_RENDERER_DB_JWT: makeJwt({ role: 'edge_label_renderer_role' }),
        }),
      }),
    ).toThrow(/SUPABASE_URL custom host .* is not allowed/i);
  });

  test('allows custom SUPABASE_URL host when allowlisted and project ref is explicit', () => {
    expect(() =>
      validateCloudEnv({
        env: baseEnv({
          DATABASE_URL: (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres'].join("")),
          SUPABASE_PROJECT_ID: 'abcdefghijklmnopqrst',
          SUPABASE_URL: 'https://fake-api.example.invalid',
          SUPABASE_ALLOWED_CUSTOM_DOMAINS: 'fake-api.example.invalid',
          EDGE_REQUIRE_DB_JWT: '1',
          API_GATEWAY_DB_JWT: makeJwt({ role: 'edge_api_gateway_role' }),
          WEBHOOK_DB_JWT: makeJwt({ role: 'edge_webhook_role' }),
          API_CALLER_DB_JWT: makeJwt({ role: 'edge_api_caller_role' }),
          LABEL_RENDERER_DB_JWT: makeJwt({ role: 'edge_label_renderer_role' }),
        }),
      }),
    ).not.toThrow();
  });

  test('rejects custom SUPABASE_URL host when SUPABASE_PROJECT_ID is missing', () => {
    expect(() =>
      validateCloudEnv({
        env: baseEnv({
          DATABASE_URL: (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres'].join("")),
          SUPABASE_URL: 'https://fake-api.example.invalid',
          SUPABASE_ALLOWED_CUSTOM_DOMAINS: 'fake-api.example.invalid',
          EDGE_REQUIRE_DB_JWT: '1',
          API_GATEWAY_DB_JWT: makeJwt({ role: 'edge_api_gateway_role' }),
          WEBHOOK_DB_JWT: makeJwt({ role: 'edge_webhook_role' }),
          API_CALLER_DB_JWT: makeJwt({ role: 'edge_api_caller_role' }),
          LABEL_RENDERER_DB_JWT: makeJwt({ role: 'edge_label_renderer_role' }),
        }),
      }),
    ).toThrow(/SUPABASE_PROJECT_ID must be set .* custom domain/i);
  });

  test('rejects project mismatch between SUPABASE_PROJECT_ID and DATABASE_URL project ref', () => {
    expect(() =>
      validateCloudEnv({
        env: baseEnv({
          DATABASE_URL: (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.bcdefghijklmnopqrstu.supabase.co',":",'5432',"/",'postgres'].join("")),
          SUPABASE_PROJECT_ID: 'abcdefghijklmnopqrst',
          SUPABASE_URL: 'https://fake-api.example.invalid',
          SUPABASE_ALLOWED_CUSTOM_DOMAINS: 'fake-api.example.invalid',
          EDGE_REQUIRE_DB_JWT: '1',
          API_GATEWAY_DB_JWT: makeJwt({ role: 'edge_api_gateway_role' }),
          WEBHOOK_DB_JWT: makeJwt({ role: 'edge_webhook_role' }),
          API_CALLER_DB_JWT: makeJwt({ role: 'edge_api_caller_role' }),
          LABEL_RENDERER_DB_JWT: makeJwt({ role: 'edge_label_renderer_role' }),
        }),
      }),
    ).toThrow(/Project mismatch/i);
  });
});
