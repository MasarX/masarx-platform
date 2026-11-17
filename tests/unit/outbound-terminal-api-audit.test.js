const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const migration = 'supabase/migrations/20260912183000_outbound_terminal_api_audit_v1.sql';
const originals = [
  'supabase/migrations/202601151330_outbound_worker_pending_edge_fix.sql',
  'supabase/migrations/202512162020_outbound_inline_dispatch.sql',
];
const body = (sql) => sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'), sql.indexOf('\n$$;') + 4);
const normalizeBlankLines = (sql) => sql.replace(/\n{3,}/g, '\n\n');
const auditBlock = /^[ \t]*-- F267 audit begin\n[\s\S]*?^[ \t]*-- F267 audit end\n\n/gm;

test.each(originals)('terminal audit preserves the complete existing function: %s', (source) => {
  const sql = read(migration);
  const stripped = sql.replace(auditBlock, '');
  const original = body(read(source));
  const expected = source.includes('outbound_inline_dispatch')
    ? original.replace('    IF NOT v_completed THEN\n        -- Dispatch a new HTTP request',
      '    IF NOT v_completed AND v_request_id IS NULL THEN\n        -- Dispatch a new HTTP request')
    : original;
  if (source.includes('outbound_inline_dispatch')) expect(expected).not.toBe(original);
  expect(normalizeBlankLines(stripped)).toContain(normalizeBlankLines(expected));
});

test('all three terminal failure audits precede provider/request retargeting', () => {
  const sql = read(migration);
  const blocks = [...sql.matchAll(new RegExp(auditBlock.source, 'gm'))]
    .filter(([block]) => block.includes("'outbound_call_failed'"));
  expect(blocks).toHaveLength(3);
  for (const match of blocks) {
    expect(sql.slice(match.index + match[0].length))
      .toMatch(/^\s*PERFORM public\.mark_outbound_call_failure(?:_v2)?\(/);
  }
});

test('six terminal audit sites use the safe canonical helper without credential-resolved request data', () => {
  const sql = read(migration);
  const blocks = sql.match(auditBlock);
  expect(blocks).toHaveLength(6);
  for (const block of blocks) {
    expect(block).toMatch(/PERFORM public\.log_api_call_event\(/);
    expect(block).toMatch(/(?:v_job\.job_id|p_job_id), '\{\}'::jsonb/);
    expect(block).not.toMatch(/v_spec|SQLERRM|GET STACKED DIAGNOSTICS|UPDATE |INSERT INTO |mark_outbound|call_api\(/);
    expect(block).toContain("RAISE WARNING 'outbound_api_audit_failed'");
  }
  expect(sql).not.toMatch(/\b(?:GRANT|REVOKE|DROP|ALTER)\b/);
});
