#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(process.cwd(), 'config', 'qa', 'frontend-a2z-ops-workflows.json');

const FORBIDDEN_PATTERNS = [
  { key: 'page.route', regex: /\bpage\.route\s*\(/g },
  { key: 'context.route', regex: /\bcontext\.route\s*\(/g },
  { key: 'browserContext.route', regex: /\bbrowserContext\.route\s*\(/g },
  { key: 'route.fulfill', regex: /\broute\.fulfill\s*\(/g },
  { key: 'route.abort', regex: /\broute\.abort\s*\(/g },
  { key: 'route.continue', regex: /\broute\.continue\s*\(/g },
];

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    config: DEFAULT_CONFIG_PATH,
    format: 'text',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    const next = String(argv[i + 1] || '').trim();
    if (!token) continue;
    if (token === '--config' && next) {
      out.config = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--config=')) {
      out.config = token.split('=').slice(1).join('=');
      continue;
    }
    if (token === '--format' && next) {
      out.format = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--format=')) {
      out.format = token.split('=').slice(1).join('=');
    }
  }
  return out;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveSuiteFiles(config) {
  const out = new Set();
  const groups = Array.isArray(config?.suite_groups) ? config.suite_groups : [];
  for (const group of groups) {
    const files = Array.isArray(group?.suite_files) ? group.suite_files : [];
    for (const file of files) {
      const normalized = String(file || '').trim();
      if (!normalized) continue;
      out.add(normalized);
    }
  }
  return [...out];
}

function buildLineIndex(content) {
  const lineStarts = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }
  return lineStarts;
}

function findLineNumber(lineStarts, index) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= index) low = mid + 1;
    else high = mid - 1;
  }
  return Math.max(1, high + 1);
}

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lineStarts = buildLineIndex(content);
  const findings = [];
  for (const pattern of FORBIDDEN_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (const match of content.matchAll(pattern.regex)) {
      const index = match.index ?? 0;
      findings.push({
        pattern: pattern.key,
        line: findLineNumber(lineStarts, index),
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

function runAudit(args = parseArgs()) {
  const configPath = path.resolve(process.cwd(), args.config);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }

  const config = readJson(configPath);
  const suiteFiles = resolveSuiteFiles(config);
  const violations = [];
  const missingFiles = [];

  for (const relativeFile of suiteFiles) {
    const absoluteFile = path.resolve(process.cwd(), relativeFile);
    if (!fs.existsSync(absoluteFile)) {
      missingFiles.push(relativeFile);
      continue;
    }
    const fileFindings = scanFile(absoluteFile);
    if (fileFindings.length === 0) continue;
    violations.push({
      file: relativeFile,
      findings: fileFindings,
    });
  }

  const report = {
    generated_at: new Date().toISOString(),
    config_path: configPath,
    status: violations.length === 0 && missingFiles.length === 0 ? 'ok' : 'failed',
    suite_file_count: suiteFiles.length,
    missing_files: missingFiles,
    violations,
  };

  if (String(args.format || '').trim().toLowerCase() === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    if (report.status === 'ok') {
      console.log(`[assert-a2z-live-suites] OK (${suiteFiles.length} suites)`);
    } else {
      console.error('[assert-a2z-live-suites] FAILED');
      for (const file of missingFiles) {
        console.error(`- missing: ${file}`);
      }
      for (const item of violations) {
        for (const finding of item.findings) {
          console.error(`- ${item.file}:${finding.line} ${finding.pattern}`);
        }
      }
    }
  }

  return report;
}

function main() {
  try {
    const report = runAudit(parseArgs());
    process.exitCode = report.status === 'ok' ? 0 : 1;
  } catch (error) {
    console.error(`[assert-a2z-live-suites] ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  runAudit,
};
