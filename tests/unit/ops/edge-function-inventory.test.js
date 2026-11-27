const fs = require('node:fs');
const path = require('node:path');
const { functions } = require('../../../config/edge/functions.json');

test('every Edge function directory has a deployment registry entry', () => {
  const directory = path.resolve(__dirname, '../../../supabase/functions');
  const registered = new Set(functions.map(entry => entry.name));
  const missing = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && !registered.has(entry.name))
    .map(entry => entry.name)
    .sort();

  expect(missing).toEqual([]);
});
