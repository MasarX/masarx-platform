#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function normalizeRelativePath(relativePath) {
  return String(relativePath || '').replace(/\\/g, '/');
}

function listPackageJsonFiles(rootDir, prefix) {
  const targetDir = path.join(rootDir, prefix);
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    return [];
  }

  const discovered = [];
  const stack = [targetDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === 'package.json') {
        discovered.push(fullPath);
      }
    }
  }

  return discovered;
}

function resolveNxCacheInputFiles(rootDir = process.cwd()) {
  const baseFiles = [
    path.join(rootDir, 'package-lock.json'),
    path.join(rootDir, 'nx.json'),
  ];
  const workspaceFiles = [
    ...listPackageJsonFiles(rootDir, 'apps'),
    ...listPackageJsonFiles(rootDir, 'packages'),
  ];

  return [...baseFiles, ...workspaceFiles]
    .filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())
    .map((filePath) => ({
      absolutePath: filePath,
      relativePath: normalizeRelativePath(path.relative(rootDir, filePath)),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function computeNxCacheKey(rootDir = process.cwd()) {
  const files = resolveNxCacheInputFiles(rootDir);
  const digest = crypto.createHash('sha256');

  for (const file of files) {
    digest.update(file.relativePath);
    digest.update('\n');
    digest.update(fs.readFileSync(file.absolutePath));
    digest.update('\n');
  }

  if (files.length === 0) {
    digest.update('nx-cache-key:empty-workspace\n');
  }

  return {
    cacheKey: digest.digest('hex'),
    fileCount: files.length,
    files: files.map((file) => file.relativePath),
  };
}

function parseArgs(argv) {
  const parsed = { format: 'text', root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--format') {
      parsed.format = String(argv[index + 1] || '').trim() || 'text';
      index += 1;
      continue;
    }
    if (token === '--root') {
      parsed.root = path.resolve(String(argv[index + 1] || '').trim() || process.cwd());
      index += 1;
      continue;
    }
  }
  return parsed;
}

function writeGitHubOutput(result) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    throw new Error('GITHUB_OUTPUT is required for --format github-output.');
  }
  const lines = [
    `cache_key=${result.cacheKey}`,
    `file_count=${String(result.fileCount)}`,
    `files_json=${JSON.stringify(result.files)}`,
  ];
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = computeNxCacheKey(args.root);

  switch (args.format) {
    case 'github-output':
      writeGitHubOutput(result);
      return;
    case 'json':
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    case 'text':
      process.stdout.write(`${result.cacheKey}\n`);
      return;
    default:
      throw new Error(`Unsupported format: ${args.format}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}

module.exports = {
  computeNxCacheKey,
  resolveNxCacheInputFiles,
};
