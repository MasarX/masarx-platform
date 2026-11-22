const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Match instruction-file shapes and hidden tool directories without a tool-name list.
const blocked = [
  /(?:^|\/)[acg][a-z]{4}[serix](?:\.[a-z0-9_-]+)?\.(?:md|txt|json|ya?ml)$/i,
  /(?:^|\/)[acg][a-z]{3}x(?:\.[a-z0-9_-]+)?\.(?:md|txt|json|ya?ml)$/i,
  /(?:^|\/)(?:agents?|instructions|prompts?)\.(?:md|txt|json|ya?ml)$/i,
  /(?:^|\/)[a-z0-9_-]*-instructions\.md$/i,
  /(?:^|\/)(?:instructions|prompts|skills)\//i,
  /(?:^|\/)\.[a-z0-9_-]+\//i,
  /(?:^|\/)\.[a-z]{3}(?:[._-]servers)?\.json$/i,
  /(?:^|\/)\.[acg][a-z]{3,6}(?:[._-][a-z0-9_-]+)?\.(?:json|toml|ya?ml)$/i,
  /(?:^|\/)\.[a-z0-9_-]*(?:rules|modes|instructions)$/i,
  /(?:^|\/)(?:agent|system)[-_](?:prompts?|instructions|roles?|skills?)(?:[-_][a-z0-9_-]+)?\./i,
  /(?:^|\/)(?:agent|system)[-_](?:catalog(?:ue)?s?|roles?|prompts?|skills?)(?:\/|\.)/i,
  /(?:^|\/)(?:review[-_](?:agent|assistant)|agent[-_]review|review[-_]policy)(?:[-_.]|\/)/i,
  /(?:^|\/)[acg][a-z]{3,5}[-_](?:os|skills|prompts|roles|instructions)(?:[-_.]|\/)/i,
];
const standardDirectory = /(?:^|\/)(?:\.github|\.well-known|\.husky|\.changeset|\.storybook|\.devcontainer|\.vscode|\.local-skip)\//g;
const rootAgentFiles = new Set(['AGENTS.md', 'DELIVERY.md', 'DESIGN.md', 'CLAUDE.md']);
const agentFileNames = new Set([...rootAgentFiles].map(file => file.toLowerCase()));
function forbidden(file, mode) {
  if (rootAgentFiles.has(file) && (mode === '100644' || mode === '100755')) return false;
  const value = file.replaceAll('\\', '/').replace(standardDirectory, '/');
  return blocked.some(pattern => pattern.test(value))
    || value.split('/').some(part => agentFileNames.has(part.toLowerCase()));
}
const pointer = ['@', 'AGENTS.md'].join('');
function validClaudePointer(source) {
  return source === pointer || source === pointer + '\n' || source === pointer + '\r\n';
}
const purpose = /(?:\b(?:you are|act as) (?:an? )?[^\n.]{0,80}\b(?:AI agent|coding agent|assistant)\b|\b(?:system[_ -]?prompt|agent[_ -]?instructions|role[_ -]?catalog|mcpServers)["']?\s*[:=])/i;
const homeState = /path\.(?:join|resolve)\([^;\r\n]{0,100}(?:homedir\(|\bhome\b|USERPROFILE)[^;\r\n]{0,100}["'](\.[a-z0-9_-]+)["']/gi;
const instructionStateShape = /^\.(?:[acg][a-z]{4}[serix]|[acg][a-z]{3}x|[a-z]\d)$/i;
function instructsAgent(source) {
  if (purpose.test(source)) return true;
  return Array.from(source.matchAll(homeState)).some(match => instructionStateShape.test(match[1]));
}

test('agent files are allowed only at exact root paths in regular Git modes', () => {
  const rootFiles = ['AGENTS.md', 'DELIVERY.md', 'DESIGN.md', 'CLAUDE.md'];
  expect(rootFiles.filter(file => forbidden(file, '100644') || forbidden(file, '100755'))).toEqual([]);
  expect(rootFiles.filter(file => !forbidden(file, '120000') || !forbidden(file, '160000'))).toEqual([]);

  const forbiddenFiles = [
    'docs/AGENTS.md', 'apps/x/CLAUDE.md', 'docs/DELIVERY.md', 'docs/DESIGN.md',
    'GEMINI.md', '.cursorrules', '.claude/settings.json', 'agents.md', 'AGENTS.md/notes.txt',
  ];
  expect(forbiddenFiles.filter(file => !forbidden(file, '100644'))).toEqual([]);
});

test('the CLAUDE.md pointer accepts only the exact text and at most one line ending', () => {
  const valid = [pointer, pointer + '\n', pointer + '\r\n'];
  const invalid = ['', pointer.toLowerCase(), '\uFEFF' + pointer, pointer + ' ', pointer + '\r',
    pointer + '\n\n', pointer + '\r\n\r\n', pointer + '\nextra'];
  expect(valid.filter(source => !validClaudePointer(source))).toEqual([]);
  expect(invalid.filter(validClaudePointer)).toEqual([]);
});

test('tracked source excludes private instruction and tool state', () => {
  const root = path.resolve(__dirname, '../..');
  const gitOptions = { cwd: root, encoding: 'utf8' };
  const entries = execFileSync('git', ['ls-files', '-z', '--format=%(objectmode) %(path)'], {
    ...gitOptions,
    maxBuffer: 8 * 1024 * 1024,
  }).split('\0').filter(Boolean);
  const files = entries.map(entry => entry.slice(7));
  expect(files.filter((file, index) => forbidden(file, entries[index].slice(0, 6)))).toEqual([]);
  if (files.includes('CLAUDE.md')) {
    expect(validClaudePointer(execFileSync('git', ['cat-file', 'blob', ':CLAUDE.md'], gitOptions))).toBe(true);
  }
  const texts = files.filter(file => /\.(?:md|txt|json|ya?ml|[cm]?js|tsx?|ps1)$/i.test(file));
  const offenders = texts.filter(file => {
    const target = path.join(root, file);
    if (!fs.lstatSync(target).isFile() || fs.statSync(target).size > 512000) return false;
    return instructsAgent(fs.readFileSync(target, 'utf8'));
  });
  expect(offenders).toEqual([]);
});
