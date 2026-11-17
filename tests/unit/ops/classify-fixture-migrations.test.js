const {
  classifyBody,
  summarize,
} = require('../../../scripts/ops/migrations/classify-fixture-migrations');

describe('classify-fixture-migrations', () => {
  test('classifies clean migrations', () => {
    const result = classifyBody(`
      CREATE TABLE IF NOT EXISTS public.demo_table (
        id uuid primary key
      );
    `);
    expect(result.className).toBe('clean');
  });

  test('classifies fixture-only migrations', () => {
    const result = classifyBody(`
      INSERT INTO webhook_sources (source_identifier, auth_token)
      VALUES ('test-client-a-ack', 'EXAMPLE_PASSWORD');
    `);
    expect(result.className).toBe('fixture_only');
    expect(result.fixtureMarkers).toBeGreaterThan(0);
    expect(result.schemaMarkers).toBe(0);
  });

  test('classifies mixed migrations', () => {
    const result = classifyBody(`
      CREATE OR REPLACE FUNCTION public.fn_demo() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;
      INSERT INTO webhook_sources (source_identifier) VALUES ('test-client-a-ack');
    `);
    expect(result.className).toBe('mixed');
  });

  test('summarizes classification buckets', () => {
    const summary = summarize([
      { class: 'clean' },
      { class: 'fixture_only' },
      { class: 'mixed' },
      { class: 'error' },
    ]);
    expect(summary.total).toBe(4);
    expect(summary.clean).toBe(1);
    expect(summary.fixture_only).toBe(1);
    expect(summary.mixed).toBe(1);
    expect(summary.error).toBe(1);
  });
});
