'use strict';
const { isIPv4 } = require('node:net');
const { git } = require('./target-policy.cjs');

const githubNoReply = /^(?:[^\s@<>]+@users\.noreply\.github\.com|noreply@github\.com)$/i;
const webFlowEmail = /^noreply@github\.com$/i;
const credentialShape = /\b(?:gh[pousr]_[a-z\d]{36}|github_pat_[a-z\d_]{82}|sb_secret_[a-z\d_-]{20,})\b|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i;
const homePath = /(?<![\w./\\-])(?:file:\/\/)?(?:[a-z]:[\\/][^\s"'`<>]|\/(?:home\/|users\/|root\/|mnt\/[a-z]\/)[^\s"'`<>])/i;
const coAuthor = /^\s*co-authored-by\s*:/i;
const toolTrailer = /^\s*(?:🤖\s*)?(?:(?:generated|assisted|created)[ -](?:with|by)(?:\s|:)|tool(?:[ -]name)?\s*:)/i;

function contentRules(text) {
  const rules = [];
  if (credentialShape.test(text)) rules.push('credential-shape');
  if (homePath.test(text)) rules.push('absolute-workstation-path');
  const addresses = text.matchAll(/(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w.])/g);
  for (const [address] of addresses) {
    if (isIPv4(address) && /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(address)) {
      rules.push('private-ipv4');
      break;
    }
  }
  return rules;
}

// The NUL-delimited raw records carry paths even for binary and mode-only changes.
function scanPatch(base, parent, sha, report) {
  const diff = git([`--attr-source=${base}`, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
    '--raw', '-z', '--patch', '--unified=0', '--diff-filter=AMT', parent, sha, '--']);
  if (!diff) return;
  const separator = diff.indexOf('\0\0');
  if (separator === -1) throw new Error('Invalid patch metadata');
  const records = diff.slice(0, separator).split('\0');
  const patches = diff.slice(separator + 2).split(/^diff --git /m);
  if (patches[0] !== '' || records.length !== 2 * (patches.length - 1)) {
    throw new Error('Invalid patch record count');
  }
  for (let index = 1; index < patches.length; index++) {
    const path = records[2 * index - 1];
    const pathRules = contentRules(path);
    const location = pathRules.length ? `commit/${sha}/path/${index}` : JSON.stringify(path).slice(1, -1);
    for (const rule of pathRules) report(rule, location, 1);
    let lineNumber = 0;
    for (const line of patches[index].split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) lineNumber = Number(hunk[1]);
      else if (lineNumber && line.startsWith('+')) {
        for (const rule of contentRules(line.slice(1))) report(rule, location, lineNumber);
        lineNumber++;
      } else if (lineNumber && line.startsWith(' ')) lineNumber++;
    }
  }
}

function scanCommit(sha, event, report) {
  const location = `commit/${sha}`;
  const fields = git(['show', '-s', '--no-show-signature', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', sha, '--']).split('\0');
  if (fields.length !== 5) throw new Error('Invalid commit metadata');
  const [author, authorEmail, committer, committerEmail, message] = fields;
  if (!githubNoReply.test(authorEmail)) report('author-email', location, 1);
  if (!githubNoReply.test(committerEmail)) report('committer-email', location, 2);
  for (const rule of contentRules(`${author} <${authorEmail}>`)) report(rule, location, 1);
  for (const rule of contentRules(`${committer} <${committerEmail}>`)) report(rule, location, 2);

  // GitHub appends the squash author's attribution when creating the queue commit.
  const queueFooter = event === 'merge_group' && webFlowEmail.test(committerEmail) && githubNoReply.test(authorEmail)
    ? `Co-authored-by: ${author} <${authorEmail}>` : null;
  const lines = message.trimEnd().split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 3;
    for (const rule of contentRules(line)) report(rule, location, lineNumber);
    if (coAuthor.test(line) && (line !== queueFooter || index !== lines.length - 1)) {
      report('co-author-trailer', location, lineNumber);
    }
    if (toolTrailer.test(line)) report('tool-attribution-trailer', location, lineNumber);
  }
}

function main() {
  const [base, head] = process.argv.slice(2);
  const event = process.env.GITHUB_EVENT_NAME;
  const isSha = value => /^[a-f0-9]{40}$/.test(value || '');
  if (!['pull_request', 'merge_group'].includes(event) || !isSha(base) || !isSha(head) || base === head ||
      git(['rev-parse', 'HEAD']).trim() !== head || git(['rev-parse', '--is-shallow-repository']).trim() !== 'false') {
    throw new Error('Invalid candidate range');
  }
  if (event === 'merge_group') git(['merge-base', '--is-ancestor', base, head]);
  const commits = git(['rev-list', '--parents', '--reverse', '--topo-order', `${base}..${head}`, '--']).trim();
  if (!commits) throw new Error('Empty candidate range');
  const rows = commits.split('\n').map(line => line.split(' '));
  const candidateShas = new Set(rows.map(([sha]) => sha));
  const report = (rule, path, line) => {
    process.exitCode = 1;
    console.error(`${rule} ${path}:${line}`);
  };
  for (const [sha, ...parents] of rows) {
    scanCommit(sha, event, report);
    // Prefer a base-side parent when a merge brings the target branch into the PR.
    const parent = parents.find(parentSha => !candidateShas.has(parentSha)) || parents[0];
    if (!parent) throw new Error('Candidate commit has no parent');
    scanPatch(base, parent, sha, report);
  }
}

try {
  main();
} catch {
  console.error('privacy-range range:1');
  process.exitCode = 1;
}
