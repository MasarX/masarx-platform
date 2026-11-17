#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join('config', 'ops', 'pre-ga-rebaseline.json');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    apply: false,
    configPath: DEFAULT_CONFIG_PATH,
    lockedBy: '',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;

    if (token === '--apply') out.apply = true;
    else if (token === '--help' || token === '-h') out.help = true;
    else if (token === '--config') out.configPath = String(argv[i + 1] || '').trim(), i += 1;
    else if (token.startsWith('--config=')) out.configPath = token.split('=').slice(1).join('=').trim();
    else if (token === '--locked-by') out.lockedBy = String(argv[i + 1] || '').trim(), i += 1;
    else if (token.startsWith('--locked-by=')) out.lockedBy = token.split('=').slice(1).join('=').trim();
  }

  return out;
}

function resolveConfigPath(inputPath) {
  const value = String(inputPath || '').trim() || DEFAULT_CONFIG_PATH;
  return path.isAbsolute(value) ? value : path.join(process.cwd(), value);
}

function readConfig(configPath) {
  const filePath = resolveConfigPath(configPath);
  const body = fs.readFileSync(filePath, 'utf8');
  return { filePath, parsed: JSON.parse(body) };
}

function buildLockedConfig(config = {}, options = {}) {
  const lockedBy = String(options.lockedBy || '').trim();
  const lockedOn = String(options.lockedOn || '').trim() || new Date().toISOString().slice(0, 10);
  const notes = String(config.notes || '').trim();
  const lockNote = `Locked on ${lockedOn}${lockedBy ? ` by ${lockedBy}` : ''} after pre-GA rebaseline completion.`;

  return {
    ...config,
    active: false,
    locked_on: lockedOn,
    ...(lockedBy ? { locked_by: lockedBy } : {}),
    notes: notes ? `${notes} ${lockNote}` : lockNote,
  };
}

function printUsage() {
  console.log('Usage: node scripts/ops/prega-rebaseline-lock.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --apply                      Persist lock update (default is dry-run)');
  console.log(`  --config <path>              Override config path (default: ${DEFAULT_CONFIG_PATH})`);
  console.log('  --locked-by <value>          Optional lock operator identifier');
  console.log('  --help, -h                   Show usage');
}

function main() {
  const args = parseArgs();
  if (args.help) {
    printUsage();
    return;
  }

  const { filePath, parsed } = readConfig(args.configPath);
  const nextConfig = buildLockedConfig(parsed, { lockedBy: args.lockedBy });

  if (!args.apply) {
    console.log(`[prega-rebaseline-lock] DRY-RUN ${filePath}`);
    console.log(JSON.stringify(nextConfig, null, 2));
    console.log('[prega-rebaseline-lock] Next manual step: clear repo variable MIGRATION_GUARDS_PRE_GA_OVERRIDE.');
    return;
  }

  fs.writeFileSync(filePath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
  console.log(`[prega-rebaseline-lock] Updated ${filePath} (active=false).`);
  console.log('[prega-rebaseline-lock] Next manual step: clear repo variable MIGRATION_GUARDS_PRE_GA_OVERRIDE.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[prega-rebaseline-lock] ${error && error.message ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = {
  buildLockedConfig,
  parseArgs,
  resolveConfigPath,
};
