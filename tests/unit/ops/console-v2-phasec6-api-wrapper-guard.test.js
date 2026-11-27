const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const integrationSource = fs.readFileSync(
  path.join(repoRoot, 'apps/console-v2/src/lib/data-source/integrations.ts'),
  'utf8',
);
const dataSources = [
  'apps/console-v2/src/lib/data-source.ts',
  'apps/console-v2/src/lib/data-source/dispatch.ts',
  'apps/console-v2/src/lib/data-source/finance.ts',
  'apps/console-v2/src/lib/data-source/fleet.ts',
  'apps/console-v2/src/lib/data-source/labels.ts',
  'apps/console-v2/src/lib/data-source/network.ts',
  'apps/console-v2/src/lib/data-source/platform.ts',
  'apps/console-v2/src/lib/data-source/resource-import.ts',
  'apps/console-v2/src/lib/data-source/shipments.ts',
  'apps/console-v2/src/lib/data-source/tasks.ts',
  'apps/console-v2/src/lib/data-source/workflows.ts',
].map((file) => fs.readFileSync(path.join(repoRoot, file), 'utf8'));
dataSources.push(integrationSource);
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
    dataSources.flatMap((dataSource) => [
      ...dataSource.matchAll(/^[ \t]*(?!\/\/).*?\bphaseC6(?:Api)?Rpc\s*\(\s*['"]([A-Za-z0-9_]+)['"]/gm),
      ...dataSource.matchAll(/^[ \t]*export\s+const\s+[A-Za-z0-9_]+\s*=\s*\([^)]*args[^)]*\)\s*=>\s*\n?\s*[A-Za-z0-9_]+\s*\(\s*['"]([A-Za-z0-9_]+)['"]/gm),
    ].map((match) => match[1])),
  );
}

function integrationOperation(name) {
  const declaration = `export async function ${name}(`;
  const [, body] = integrationSource.split(declaration);
  return declaration + (body ?? '').split(/\r?\nexport /, 1)[0];
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
    for (const dataSource of dataSources) {
      expect(dataSource).not.toMatch(
        /phaseC6(?:Api)?Rpc\s*\(\s*['"]ui_upsert_mapping_artifact_v1['"]/,
      );
      expect(dataSource).not.toMatch(
        /phaseC6(?:Api)?Rpc\s*\(\s*['"]ui_create_mapping_operation_report_v1['"]/,
      );
    }
    expect(integrationOperation('ui_upsert_mapping_artifact_v1')).toMatch(/ui_upsert_mapping_artifact_v1[\s\S]*p_artifact:\s*args/);
    expect(integrationOperation('ui_create_mapping_operation_report_v1')).toMatch(/ui_create_mapping_operation_report_v1[\s\S]*p_report:\s*args/);
  });
});
