#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);

const parseArgs = (list) => {
  const out = {};
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = list[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
};

const usage = () => {
  console.log('Usage: print-figma-tags --mapping <mapping.json>');
  process.exit(1);
};

const main = () => {
  const args = parseArgs(argv);
  const mappingRel = args.mapping || args.m;
  if (!mappingRel) usage();
  const mappingPath = path.resolve(process.cwd(), mappingRel);
  if (!fs.existsSync(mappingPath)) {
    console.error(`mapping not found: ${mappingPath}`);
    process.exit(1);
  }

  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
  const sections = Array.isArray(mapping.sections) ? mapping.sections : [];
  const fieldsObj = mapping.fields && typeof mapping.fields === 'object' ? mapping.fields : {};
  const fieldKeys = Object.entries(fieldsObj)
    .filter(([, def]) => def && !def.ignore)
    .map(([k]) => k)
    .sort();

  console.log('Create a group named: EXPORT');
  console.log('');
  console.log('Sections (create frames/rectangles):');
  for (const s of sections) console.log(`- section:${s}`);
  console.log('');
  console.log('Fields (create rectangles/text tags):');
  for (const k of fieldKeys) console.log(`- field:${k}`);
};

main();

