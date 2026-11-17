#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');

const DEFAULT_WORKFLOW_DIR = path.join(process.cwd(), '.github', 'workflows');
const DEFAULT_POLICY_PATH = path.join(
  process.cwd(),
  'config',
  'ci',
  'actions-artifact-retention-policy.json',
);
const REUSABLE_RETENTION_INPUT_EXPRESSION = /^\$\{\{\s*inputs\.artifact_retention_days\s*\}\}$/;

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(target);
    return /\.(ya?ml)$/i.test(entry.name) ? [target] : [];
  });
}

function lineIndent(line) {
  return String(line || '').match(/^\s*/)[0].length;
}

function previousStepName(lines, index) {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const match = String(lines[cursor] || '').match(/^\s*-\s+name:\s*(.+)$/);
    if (match) return match[1].trim();
    if (/^\s*steps:\s*$/.test(String(lines[cursor] || ''))) break;
  }
  return '';
}

function findWithBlock(lines, usesIndex) {
  const usesIndent = lineIndent(lines[usesIndex]);
  let withIndex = -1;
  for (let cursor = usesIndex + 1; cursor < lines.length; cursor += 1) {
    const line = String(lines[cursor] || '');
    const indent = lineIndent(line);
    if (indent <= usesIndent && /^\s*-\s+name:/.test(line)) break;
    if (/^\s*with:\s*$/.test(line)) {
      withIndex = cursor;
      break;
    }
  }
  if (withIndex < 0) return null;

  let endIndex = lines.length;
  for (let cursor = withIndex + 1; cursor < lines.length; cursor += 1) {
    const line = String(lines[cursor] || '');
    const indent = lineIndent(line);
    if (indent <= usesIndent && (/^\s*-\s+name:/.test(line) || /^\s*[A-Za-z0-9_-]+:\s*$/.test(line))) {
      endIndex = cursor;
      break;
    }
  }

  return {
    start: withIndex,
    end: endIndex,
    text: lines.slice(withIndex + 1, endIndex).join('\n'),
  };
}

function findStepBlock(lines, usesIndex) {
  const usesIndent = lineIndent(lines[usesIndex]);
  let startIndex = usesIndex;

  for (let cursor = usesIndex; cursor >= 0; cursor -= 1) {
    const line = String(lines[cursor] || '');
    if (lineIndent(line) <= usesIndent && /^\s*-\s+/.test(line)) {
      startIndex = cursor;
      break;
    }
    if (/^\s*steps:\s*$/.test(line)) break;
  }

  let endIndex = lines.length;
  for (let cursor = usesIndex + 1; cursor < lines.length; cursor += 1) {
    const line = String(lines[cursor] || '');
    const indent = lineIndent(line);
    if (indent <= usesIndent && /^\s*-\s+/.test(line)) {
      endIndex = cursor;
      break;
    }
  }

  return {
    start: startIndex,
    end: endIndex,
    text: lines.slice(startIndex, endIndex).join('\n'),
  };
}

function findYamlBlock(lines, keyIndex) {
  const keyIndent = lineIndent(lines[keyIndex]);
  let endIndex = lines.length;
  for (let cursor = keyIndex + 1; cursor < lines.length; cursor += 1) {
    const line = String(lines[cursor] || '');
    if (!line.trim()) continue;
    const indent = lineIndent(line);
    if (indent <= keyIndent && /^\s*[A-Za-z0-9_-]+:\s*/.test(line)) {
      endIndex = cursor;
      break;
    }
  }

  return {
    start: keyIndex,
    end: endIndex,
    text: lines.slice(keyIndex, endIndex).join('\n'),
  };
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function loadRetentionPolicy(policyPath = DEFAULT_POLICY_PATH) {
  if (!policyPath || !fs.existsSync(policyPath)) return null;
  return JSON.parse(fs.readFileSync(policyPath, 'utf8'));
}

function maxRetentionDaysFromPolicy(policy) {
  const hours = [
    parsePositiveInt(policy?.default_retention_hours),
    ...(Array.isArray(policy?.rules)
      ? policy.rules.map((rule) => parsePositiveInt(rule?.max_age_hours))
      : []),
  ].filter((value) => value !== null);
  if (!hours.length) return 7;
  return Math.max(1, Math.ceil(Math.max(...hours) / 24));
}

function parseWithProperties(text) {
  const lines = String(text || '').split('\n');
  const properties = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '');
    const match = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;

    const indent = match[1].length;
    const key = match[2];
    const rawValue = match[3].trim();
    const valueLines = [];

    if (rawValue && rawValue !== '|' && rawValue !== '>') {
      valueLines.push(rawValue);
    }

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const nextLine = String(lines[cursor] || '');
      if (!nextLine.trim()) continue;
      const nextIndent = lineIndent(nextLine);
      if (nextIndent <= indent) break;
      if (nextIndent > indent && !nextLine.match(/^\s*[A-Za-z0-9_-]+:\s*(.*)$/)) {
        valueLines.push(nextLine.trim());
      }
    }

    properties.set(key, {
      value: rawValue,
      lines: valueLines,
    });
  }

  return properties;
}

function extractUploadBlocks(filePath) {
  const body = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  const lines = body.split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!String(lines[index] || '').includes('uses: actions/upload-artifact@')) continue;
    blocks.push({
      filePath,
      line: index + 1,
      stepName: previousStepName(lines, index),
      stepBlock: findStepBlock(lines, index),
      withBlock: findWithBlock(lines, index),
    });
  }
  return blocks;
}

function stripQuotes(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function isBroadArtifactPath(value) {
  const normalized = stripQuotes(value).replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalized) return false;
  if (/^(\.|\.\.|\*\*|\*\*\/\*|\/)$/.test(normalized)) return true;
  if (/\/\*\*$/.test(normalized) || /\/\*\*\/\*$/.test(normalized)) return true;
  return false;
}

function isLocalReusableWorkflow(value) {
  const normalized = stripQuotes(value).replace(/\\/g, '/');
  return normalized.startsWith('./.github/workflows/') && /\.(ya?ml)$/i.test(normalized);
}

function isReusableWorkflowFile(filePath) {
  const target = String(filePath || '').trim();
  if (!target || !fs.existsSync(target)) return false;
  const normalized = target.replace(/\\/g, '/');
  return /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(normalized)
    && fs.readFileSync(target, 'utf8').includes('workflow_call:');
}

function extractReusableArtifactInputBlocks(filePath) {
  const body = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  const lines = body.split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '');
    const match = line.match(/^\s*uses:\s*(.+)$/);
    if (!match || !isLocalReusableWorkflow(match[1])) continue;
    const withBlock = findWithBlock(lines, index);
    if (!withBlock) continue;
    const properties = parseWithProperties(withBlock.text);
    if (!properties.has('artifact_path')) continue;
    blocks.push({
      filePath,
      line: index + 1,
      reusableWorkflow: stripQuotes(match[1]),
      jobBlock: findYamlBlock(lines, index),
      withBlock,
    });
  }
  return blocks;
}

function validateUploadBlock(block, { maxRetentionDays = 7 } = {}) {
  const errors = [];
  const text = block.withBlock?.text || '';
  if (!block.withBlock) {
    errors.push('missing with block');
    return errors;
  }

  const stepProperties = parseWithProperties(block.stepBlock?.text || '');
  const continueOnError = stripQuotes(stepProperties.get('continue-on-error')?.value).toLowerCase();
  if (!continueOnError) {
    errors.push('missing explicit continue-on-error: true');
  } else if (continueOnError !== 'true') {
    errors.push('continue-on-error must be true');
  }

  const properties = parseWithProperties(text);
  const retention = stripQuotes(properties.get('retention-days')?.value);
  if (!retention) {
    errors.push('missing explicit retention-days');
  } else if (REUSABLE_RETENTION_INPUT_EXPRESSION.test(retention) && isReusableWorkflowFile(block.filePath)) {
    // Reusable workflow callers are validated through artifact_retention_days.
  } else if (!/^\d+$/.test(retention)) {
    errors.push('retention-days must be a numeric literal');
  } else if (Number.parseInt(retention, 10) > maxRetentionDays) {
    errors.push(`retention-days exceeds policy maximum (${maxRetentionDays} days)`);
  }

  const includeHiddenFiles = stripQuotes(properties.get('include-hidden-files')?.value).toLowerCase();
  if (!includeHiddenFiles) {
    errors.push('missing explicit include-hidden-files: false');
  } else if (includeHiddenFiles !== 'false') {
    errors.push('include-hidden-files must be false');
  }

  const pathLines = properties.get('path')?.lines || [];
  const broadPath = pathLines.some((line) => isBroadArtifactPath(line));
  if (broadPath) {
    errors.push('artifact path is too broad');
  }

  return errors;
}

function validateReusableArtifactInputBlock(block, { maxRetentionDays = 7 } = {}) {
  const errors = [];
  const properties = parseWithProperties(block.withBlock?.text || '');
  const artifactPath = properties.get('artifact_path');
  if (!artifactPath) return errors;

  if ((artifactPath.lines || []).some((line) => isBroadArtifactPath(line))) {
    errors.push('reusable artifact_path is too broad');
  }

  const retention = stripQuotes(properties.get('artifact_retention_days')?.value);
  if (retention) {
    if (/^\$\{\{\s*inputs\.[A-Za-z0-9_-]+\s*\}\}$/.test(retention)) {
      return errors;
    }
    if (!/^\d+$/.test(retention)) {
      errors.push('reusable artifact_retention_days must be a numeric literal');
    } else if (Number.parseInt(retention, 10) > maxRetentionDays) {
      errors.push(`reusable artifact_retention_days exceeds policy maximum (${maxRetentionDays} days)`);
    }
  }

  return errors;
}

function lintWorkflowArtifacts({
  workflowDir = DEFAULT_WORKFLOW_DIR,
  policyPath = DEFAULT_POLICY_PATH,
} = {}) {
  const violations = [];
  const maxRetentionDays = maxRetentionDaysFromPolicy(loadRetentionPolicy(policyPath));
  for (const filePath of walkFiles(workflowDir)) {
    for (const block of extractUploadBlocks(filePath)) {
      for (const error of validateUploadBlock(block, { maxRetentionDays })) {
        violations.push({
          file: path.relative(process.cwd(), block.filePath).replace(/\\/g, '/'),
          line: block.line,
          step: block.stepName,
          error,
        });
      }
    }
    for (const block of extractReusableArtifactInputBlocks(filePath)) {
      for (const error of validateReusableArtifactInputBlock(block, { maxRetentionDays })) {
        violations.push({
          file: path.relative(process.cwd(), block.filePath).replace(/\\/g, '/'),
          line: block.line,
          step: block.reusableWorkflow,
          error,
        });
      }
    }
  }
  return violations;
}

function main() {
  const violations = lintWorkflowArtifacts();
  if (!violations.length) {
    console.log('[actions-artifact-governance-lint] OK');
    return;
  }

  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line} ${violation.step || '<unnamed step>'}: ${violation.error}`,
    );
  }
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  extractReusableArtifactInputBlocks,
  extractUploadBlocks,
  lintWorkflowArtifacts,
  maxRetentionDaysFromPolicy,
  parseWithProperties,
  validateReusableArtifactInputBlock,
  validateUploadBlock,
};
