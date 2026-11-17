#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv/dist/2020');

const ROOT = process.cwd();
const SCHEMA_PATH = path.join(ROOT, 'supabase', 'templates', 'label_renderer.schema.json');

const argv = process.argv.slice(2);

const getTemplateFiles = () => {
  if (argv.length > 0) {
    return argv.map((p) => path.resolve(ROOT, p));
  }
  const dir = path.join(ROOT, 'supabase', 'templates');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'label_renderer.schema.json')
    .map((f) => path.join(dir, f));
};

const main = () => {
  if (!fs.existsSync(SCHEMA_PATH)) {
    throw new Error(`Schema not found at ${SCHEMA_PATH}`);
  }
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  const files = getTemplateFiles();
  if (files.length === 0) {
    console.log('[templates:validate] No template files found');
    return;
  }

  let failures = 0;
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(`[templates:validate] Invalid JSON: ${file}`, err.message);
      failures += 1;
      continue;
    }
    const valid = validate(parsed);
    if (!valid) {
      failures += 1;
      console.error(`[templates:validate] ${file} failed schema validation`);
      for (const err of validate.errors || []) {
        console.error(`  - ${err.instancePath || '<root>'} ${err.message}`);
      }
    } else {
      console.log(`[templates:validate] ${file} OK`);
    }
  }

  if (failures > 0) {
    console.error(`[templates:validate] Completed with ${failures} invalid file(s)`);
    process.exit(1);
  } else {
    console.log('[templates:validate] All templates valid');
  }
};

main();
