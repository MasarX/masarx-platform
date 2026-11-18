const fs = require('fs');
const path = require('path');
test('latest source-binding core retains configured missing-template failure through append-only repair', () => {
  const root = path.resolve(__dirname, '../../..');
  const core = fs.readFileSync(path.join(root, 'supabase/migrations/20260910003000_webhook_shipment_create_source_binding_v1.sql'), 'utf8');
  const repair = fs.readFileSync(path.join(root, 'supabase/migrations/20260911114000_webhook_missing_template_reapply_v1.sql'), 'utf8');
  const oldBlock = repair.match(/v_old TEXT := \$old\$([\s\S]*?)\$old\$;/)[1];
  const newBlock = repair.match(/v_new TEXT := \$new\$([\s\S]*?)\$new\$;/)[1];
  expect(core.split(oldBlock)).toHaveLength(2);
  const offset = core.indexOf(oldBlock);
  const repaired = core.replace(oldBlock, newBlock);
  expect(repaired.slice(0,offset)).toBe(core.slice(0,offset));
  expect(repaired.slice(offset+newBlock.length)).toBe(core.slice(offset+oldBlock.length));
  expect(newBlock).toContain("'response_reason', 'missing_entry_template'");
  expect(newBlock).toContain("COALESCE(NULLIF(v_defaults->>'error_status', '')::INT, 500)");
  expect(repaired).toContain("'webhook_source_missing_sender_client'");
  expect(repair).toContain("(length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old)");
});
