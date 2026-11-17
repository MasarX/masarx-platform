const fs = require('fs');
const path = require('path');

const readJson = (filePath) =>
  JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));

describe('Public OpenAPI contract', () => {
  const openapiPath = path.join(__dirname, '..', '..', 'docs', 'api', 'openapi.json');
  const spec = readJson(openapiPath);

  test('documents deprecated EXAMPLE_PASSWORD migration auth', () => {
    expect(spec.info.description).toContain('/v1/webhook?token=');

    const scheme = spec.components.securitySchemes.WebhookQueryToken;
    expect(scheme).toBeTruthy();
    expect(scheme.type).toBe('apiKey');
    expect(scheme.in).toBe('query');
    expect(scheme.name).toBe('token');
  });

  test('/v1/webhook includes EXAMPLE_PASSWORD as an alternative security requirement', () => {
    const op = spec.paths['/v1/webhook'].post;
    const security = op.security || [];
    const hasQuery = security.some((req) =>
      Object.prototype.hasOwnProperty.call(req, 'WebhookQueryToken')
    );
    expect(hasQuery).toBe(true);
  });

  test('uses deterministic content-derived contract version metadata', () => {
    expect(spec.info.version).toMatch(/^contract-[a-f0-9]{12}$/);
    expect(spec.info['x-versioning-policy']).toBe(
      'contract-<sha256(openapi_without_info.version)[:12]>'
    );
  });

  test('defines standardized ErrorResponse envelope with backward-compatible alias', () => {
    const errorSchema = spec.components.schemas.ErrorResponse;
    expect(errorSchema).toBeTruthy();
    expect(errorSchema.required).toEqual(
      expect.arrayContaining(['code', 'message', 'status', 'correlation_id'])
    );
    expect(errorSchema.properties.code.type).toBe('string');
    expect(errorSchema.properties.message.type).toBe('string');
    expect(errorSchema.properties.error.type).toBe('string');
    expect(errorSchema.properties.status.minimum).toBe(400);
    expect(errorSchema.properties.status.maximum).toBe(599);
    expect(errorSchema.properties.correlation_id.format).toBe('uuid');
    expect(errorSchema.additionalProperties).toBe(false);
  });

  test('references ErrorResponse for platform-generated 4xx/5xx responses on /v1 and /api surfaces', () => {
    const webhookPost = spec.paths['/v1/webhook'].post;
    for (const status of ['400', '401', '500']) {
      const schemaRef =
        webhookPost.responses?.[status]?.content?.['application/json']?.schema?.$ref || null;
      expect(schemaRef).toBe('#/components/schemas/ErrorResponse');
    }

    const apiEntry = Object.entries(spec.paths).find(([pathKey]) => pathKey.startsWith('/api/'));
    if (!apiEntry) {
      // /api mirrors are dynamically derived from DB route-pack rows and may be absent.
      return;
    }

    const [, apiPathItem] = apiEntry;
    const apiOperation = Object.values(apiPathItem).find(
      (candidate) => candidate && typeof candidate === 'object' && candidate.responses
    );
    expect(apiOperation).toBeTruthy();
    for (const status of ['400', '401', '404', '429', '500']) {
      const schemaRef =
        apiOperation.responses?.[status]?.content?.['application/json']?.schema?.$ref || null;
      expect(schemaRef).toBe('#/components/schemas/ErrorResponse');
    }
  });
});
