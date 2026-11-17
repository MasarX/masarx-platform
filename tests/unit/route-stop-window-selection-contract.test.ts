import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@jest/globals';
test('native preservation fixture executes the exact shipped route-window repair block twice', () => {
  const migration = readFileSync(resolve(process.cwd(),'supabase/migrations/20260911233000_route_stop_registry_window_columns_v1.sql'),'utf8').replace(/\r\n/g, '\n');
  const fixture = readFileSync(resolve(process.cwd(),'supabase/tests/pgtap/0zz_route_stop_window_selection_repair_v1.sql'),'utf8').replace(/\r\n/g, '\n');
  const block = migration.slice(migration.indexOf('DO $repair$'),migration.indexOf('\nCOMMIT;'));
  expect(block.length).toBeGreaterThan(100);
  expect(fixture.split(block)).toHaveLength(3);
});
