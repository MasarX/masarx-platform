'use strict';
const { execFileSync } = require('node:child_process');
const { readFileSync, readdirSync } = require('node:fs');

const workflowFile = '.github/workflows/deploy.yml';
const deployDirectory = 'scripts/deploy';
const allowedMissingDev = new Map([
  [`${deployDirectory}/apply-guard.cjs`, new Set([
    // G2 still counts historical dev database applies in its 30-day window.
    "const deploymentBranches = ['main', 'dev'];",
  ])],
]);

const indent = line => line.search(/\S/);

function yamlChild(lines, parent, key) {
  const keyStart = new RegExp(`^(['"]?)${key}\\1:`);
  let childIndent;
  for (let index = parent + 1; index < lines.length; index++) {
    const level = indent(lines[index]);
    if (level < 0) continue;
    if (level <= indent(lines[parent])) break;
    childIndent ??= level;
    if (level === childIndent && keyStart.test(lines[index].trimStart())) return index;
  }
  return -1;
}

// shortcut: Recognize block workflow keys and literal lists, use a YAML parser if deploy.yml adopts YAML aliases or flow maps for its triggers.
function pushBranches(lines, add) {
  const on = lines.findIndex(line => /^(['"]?)on\1:\s*$/.test(line));
  if (on === -1) return;
  const push = yamlChild(lines, on, 'push');
  if (push === -1) return;
  const branches = yamlChild(lines, push, 'branches');
  if (branches === -1) return;
  const value = lines[branches].slice(lines[branches].indexOf(':') + 1).trim();
  if (value.startsWith('[')) {
    let chunk = value.slice(1);
    for (let index = branches; index < lines.length; index++, chunk = lines[index]?.trim()) {
      const end = /\]\s*$/.test(chunk);
      for (const item of chunk.replace(/\]\s*$/, '').split(',')) add(item.trim().replace(/^(['"])(.*)\1$/, '$2'), index);
      if (end) break;
    }
  } else if (!value) {
    for (let index = branches + 1; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      const item = /^\s*-\s+(.+)$/.exec(lines[index]);
      if (!item || indent(lines[index]) < indent(lines[branches])) break;
      add(item[1].trim().replace(/^(['"])(.*)\1$/, '$2'), index);
    }
  }
}

function extractBranchReferences(file, source) {
  const workflow = file === workflowFile;
  const javascript = /\.[cm]?js$/.test(file);
  const code = javascript ? source.replace(
    /(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (token, quote) => quote ? token : token.replace(/[^\r\n]/g, ' '),
  ) : source;
  const lines = code.split(/\r?\n/).map(line => {
    if (/^\s*#/.test(line)) return '';
    return workflow ? line.replace(/\s+#.*$/, '') : line;
  });
  const text = lines.join('\n');
  const references = [];
  const add = (branch, index) => {
    if (!branch || branch.endsWith('/') || /[\s*?\[${]/.test(branch)) return;
    references.push({ file, line: index + 1, branch, context: lines[index].trim() });
  };
  const indexAt = offset => text.slice(0, offset).split('\n').length - 1;

  for (const match of text.matchAll(/(?:\brefs\/heads\/|\/git\/ref\/heads\/)([^\s"'`|:;(){}<>,&=\\\]]+)/g)) {
    add(match[1], indexAt(match.index));
  }

  if (workflow) {
    pushBranches(lines, (branch, index) => {
      if (!branch.startsWith('!') && !branch.includes('+')) add(branch, index);
    });
    const branchField = String.raw`\bgithub\.(?:ref_name|head_ref|base_ref|event\.pull_request\.(?:base|head)\.ref)\b`;
    const literal = String.raw`(['"])([^'"\s]+)\1`;
    const operator = String.raw`\s*(?:==|!=)\s*`;
    for (const expression of [branchField + operator + literal, literal + operator + branchField]) {
      for (const match of text.matchAll(new RegExp(expression, 'gi'))) {
        const [, quote, branch] = match;
        if (!branch.startsWith('refs/heads/')) add(branch, indexAt(match.index + match[0].indexOf(quote + branch)));
      }
    }
  } else if (javascript) {
    for (const list of text.matchAll(/\b(?:branches|[\w$]+branches)\s*=\s*\[([^\]]*)\]/gi)) {
      const offset = list.index + list[0].indexOf('[') + 1;
      for (const item of list[1].matchAll(/(?:^|,)\s*(['"`])([^'"`\s]+)\1\s*(?=,|$)/g)) {
        add(item[2], indexAt(offset + item.index + item[0].indexOf(item[1])));
      }
    }
  }

  return references.sort((left, right) => left.line - right.line);
}

function missingBranches(references, remoteBranches, allowlist = allowedMissingDev) {
  return references.filter(({ file, branch, context }) =>
    !remoteBranches.has(branch) && !(branch === 'dev' && allowlist.get(file)?.has(context)));
}

function originBranches() {
  try {
    const refs = execFileSync('git', ['ls-remote', '--exit-code', '--heads', 'origin'], {
      encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return new Set([...refs.matchAll(/\trefs\/heads\/(.+)$/gm)].map(match => match[1]));
  } catch {
    throw new Error('Could not list remote branches from origin');
  }
}

function main() {
  const files = [workflowFile, ...readdirSync(deployDirectory, { recursive: true })
    .filter(file => /\.(?:[cm]?js|sh)$/.test(file) && !/\.test\.sh$/.test(file))
    .map(file => `${deployDirectory}/${file.replaceAll('\\', '/')}`).sort()];
  const references = files.flatMap(file => extractBranchReferences(file, readFileSync(file, 'utf8')));
  const missing = missingBranches(references, originBranches());
  for (const { file, line, branch } of missing) {
    console.error(`${file}:${line}: branch ${JSON.stringify(branch)} does not exist on origin`);
  }
  if (missing.length) process.exitCode = 1;
  else console.log(`Checked ${references.length} deploy branch references against origin.`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { extractBranchReferences, missingBranches, originBranches };
