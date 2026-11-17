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
});

