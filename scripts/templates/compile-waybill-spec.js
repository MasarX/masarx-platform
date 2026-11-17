#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { compileWaybillSpec, loadInputs } = require('./waybill-spec-compiler');

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

const main = () => {
  const args = parseArgs(argv);
  const geometryPath = args.geometry || args.g;
  const mappingPath = args.mapping || args.m;

  if (!geometryPath || !mappingPath) {
    console.error('Usage: compile-waybill-spec --geometry <WAYBILL_GEOMETRY.json> --mapping <mapping.json> [--out out.json] [--allow-missing]');
    process.exit(1);
  }

  const geoFile = path.resolve(process.cwd(), geometryPath);
  const mapFile = path.resolve(process.cwd(), mappingPath);
  const { geometry, mapping } = loadInputs(geoFile, mapFile);

  const compiled = compileWaybillSpec(geometry, mapping, { allowMissing: !!args['allow-missing'] });

  const json = JSON.stringify(compiled, null, 2);
  if (args.out) {
    const outFile = path.resolve(process.cwd(), args.out);
    fs.writeFileSync(outFile, `${json}\n`);
    console.log(`[compile-waybill-spec] wrote ${outFile}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
};

main();

