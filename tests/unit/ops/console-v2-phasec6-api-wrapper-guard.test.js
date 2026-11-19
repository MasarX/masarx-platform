const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const dataSource = fs.readFileSync(
  path.join(repoRoot, 'apps', 'console-v2', 'src', 'lib', 'data-source.ts'),
  'utf8',
);
const migrationsDir = path.join(repoRoot, 'supabase', 'migrations');
const migrationFiles = fs
  .readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function phaseC6RpcNames() {
  return uniqueSorted(
    [
      ...dataSource.matchAll(/^[ \t]*(?!\/\/).*?\bphaseC6(?:Api)?Rpc\s*\(\s*['"]([A-Za-z0-9_]+)['"]/gm),
      ...dataSource.matchAll(/^[ \t]*export\s+const\s+[A-Za-z0-9_]+\s*=\s*\([^)]*args[^)]*\)\s*=>\s*\n?\s*[A-Za-z0-9_]+\s*\(\s*['"]([A-Za-z0-9_]+)['"]/gm),
    ]
      .map((match) => match[1]),
  );
}

function apiWrapperNames() {
  const names = new Set();

  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    for (const match of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+api\.([A-Za-z0-9_]+)\s*\(/gi)) {
      names.add(match[1]);
    }

    if (!/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+api\.%/i.test(sql)) {
      continue;
    }

    for (const arrayMatch of sql.matchAll(/\b[A-Za-z0-9_]+\s+TEXT\[\]\s*:=\s*ARRAY\s*\[([\s\S]*?)\]\s*;/gi)) {
      for (const nameMatch of arrayMatch[1].matchAll(/'([A-Za-z0-9_]+)'/g)) {
        names.add(nameMatch[1]);
      }
    }
  }

  return names;
}

describe('Console V2 phaseC6 RPC api-wrapper guard', () => {
  test('every phaseC6Rpc call has an api-schema wrapper', () => {
    const phaseNames = phaseC6RpcNames();
    const wrapperNames = apiWrapperNames();

    expect(phaseNames.length).toBeGreaterThan(90);

    const missing = phaseNames.filter((name) => !wrapperNames.has(name));
    expect(missing).toEqual([]);
  });

  test('mapping save/report do not use the generic p_args wrapper path', () => {
    expect(dataSource).not.toMatch(
      /phaseC6(?:Api)?Rpc\s*\(\s*['"]ui_upsert_mapping_artifact_v1['"]/,
    );
    expect(dataSource).not.toMatch(
      /phaseC6(?:Api)?Rpc\s*\(\s*['"]ui_create_mapping_operation_report_v1['"]/,
    );
    expect(dataSource).toMatch(/ui_upsert_mapping_artifact_v1[\s\S]*p_artifact:\s*args/);
    expect(dataSource).toMatch(/ui_create_mapping_operation_report_v1[\s\S]*p_report:\s*args/);
  });
});
