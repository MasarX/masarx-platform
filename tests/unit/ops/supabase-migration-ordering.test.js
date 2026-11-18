const fs = require('fs');
const path = require('path');

describe('supabase migrations ordering', () => {
  test('migration filenames are ordered by version when sorted lexicographically', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const dir = path.join(repoRoot, 'supabase', 'migrations');
    const entries = fs.readdirSync(dir).slice().sort();

    const versions = [];
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.sql')) continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;

      const m = name.match(/^(\d+)_.*\.sql$/i);
      if (!m) {
        throw new Error(`Migration file does not match <version>_<name>.sql: ${name}`);
      }
      versions.push({ name, version: m[1] });
    }

    for (let i = 1; i < versions.length; i += 1) {
      const prev = versions[i - 1];
      const cur = versions[i];
      if (cur.version < prev.version) {
        throw new Error(
          `Migrations out of order: ${cur.name} (v=${cur.version}) sorts after ${prev.name} (v=${prev.version}).`,
        );
      }
    }
  });

  test('defines the API Gateway route intent helper before every qualified call', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const dir = path.join(repoRoot, 'supabase', 'migrations');
    const entries = fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
    const symbol = 'public.api_gateway_route_canonical_intent_v1';
    const definitionToken = 'CREATE OR REPLACE FUNCTION ' + symbol;
    let definition = null;
    const calls = [];

    for (const name of entries) {
      const sql = fs.readFileSync(path.join(dir, name), 'utf8');
      const definitionOffset = sql.indexOf(definitionToken);
      if (definitionOffset >= 0 && definition === null) definition = { name, offset: definitionOffset };
      let offset = sql.indexOf(symbol + '(');
      while (offset >= 0) {
        if (offset !== definitionOffset + 'CREATE OR REPLACE FUNCTION '.length) calls.push({ name, offset });
        offset = sql.indexOf(symbol + '(', offset + symbol.length);
      }
    }

    expect(definition).not.toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.name > definition.name || (call.name === definition.name && call.offset > definition.offset)).toBe(true);
    }
  });
});

