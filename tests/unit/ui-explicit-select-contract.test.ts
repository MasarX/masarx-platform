import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';

const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260911230000_ui_explicit_select_repair_v1.sql'), 'utf8');
describe('registry explicit output selection contract', () => {
  it('retains both scope guards and exact public signatures', () => {
    expect(sql.match(/PERFORM public.ui_assert_resource_read_scope_v1/g)).toHaveLength(2);
    expect(sql).toContain('p_id UUID');
    expect(sql).not.toContain('pg_get_functiondef');
  });
  it('restricts both actual output queries, while absence keeps legacy wildcard', () => {
    expect(sql.match(/v_select_cols TEXT := '\*'/g)).toHaveLength(2);
    expect(sql.match(/IF v_resource \? 'select' THEN/g)).toHaveLength(2);
    expect(sql.match(/v_select_cols := selected_sql/g)).toHaveLength(2);
    expect(sql).toContain('v_select_keys := selected_columns;');
    expect(sql.match(/string_agg\(format\('%I',name\)/g)).toHaveLength(2);
  });
  it('rejects malformed, empty and non-column selections without changing sibling readers', () => {
    expect(sql.match(/jsonb_typeof\(v_resource->'select'\) IS DISTINCT FROM 'array'/g)).toHaveLength(2);
    expect(sql.match(/jsonb_typeof\(e\) IS DISTINCT FROM 'string'/g)).toHaveLength(2);
    expect(sql.match(/jsonb_array_length\(v_resource->'select'\)=0/g)).toHaveLength(2);
    expect(sql.match(/c.column_name=selected_name/g)).toHaveLength(2);
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.ui_resource_metrics_v1');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.ui_filter_distinct_values_v1');
  });
});
