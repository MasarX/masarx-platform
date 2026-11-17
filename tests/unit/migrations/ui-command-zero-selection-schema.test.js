const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const sql = fs.readFileSync(path.join(__dirname, '../../../supabase/migrations/20260909113000_ui_command_zero_selection_schema_v1.sql'), 'utf8');
const literal = name => JSON.parse(sql.split('$' + name + '$')[1]);
const original = { type: 'object', properties: { commands: { type: 'array', items: {
 type: 'object', properties: { selection: { type: 'object', properties: {
 mode: { type: 'string' }, max_count: { type: 'integer', minimum: 1 } } },
 execution: { type: 'object', properties: { result_contract: { enum: ['batch_items_v1'] } } }
 } } } } };
const successor = structuredClone(original);
const target = successor.properties.commands.items.properties.selection;
target.properties.max_count = literal('zero_max');
target.allOf = literal('zero_guard');
const validate = new Ajv({ strict: false }).compile(successor);
test.each([
 ['none', 0, true], ['single', 0, false], ['multi', 0, false],
 ['any', 0, false], [undefined, 0, false], ['none', -1, false],
 ['none', null, false], ['none', '0', false], ['single', 1, true],
 ['none', 1, true], ['single', undefined, true], [undefined, undefined, true],
])('selection mode %s cap %s valid=%s', (mode, max, valid) => {
 const selection = {};
 if (mode !== undefined) selection.mode = mode;
 if (max !== undefined) selection.max_count = max;
 expect(validate({ commands: [{ key: 'test', label: 'Test', capability: 'test.read', selection }] })).toBe(valid);
});
test('only the explicit zero-selection schema contract changes', () => {
 const restored = structuredClone(successor);
 const selection = restored.properties.commands.items.properties.selection;
 selection.properties.max_count = original.properties.commands.items.properties.selection.properties.max_count;
 delete selection.allOf;
 expect(restored).toEqual(original);
});
test('unrelated result contract remains enforced', () => {
 expect(validate({commands:[{selection:{mode:'none',max_count:0},execution:{result_contract:'wrong'}}]})).toBe(false);
});
