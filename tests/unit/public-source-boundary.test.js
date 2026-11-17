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
function forbidden(file) {
  const value = file.replaceAll('\\', '/').replace(standardDirectory, '/');
  return blocked.some(pattern => pattern.test(value));
}
const purpose = /(?:\b(?:you are|act as) (?:an? )?[^\n.]{0,80}\b(?:AI agent|coding agent|assistant)\b|\b(?:system[_ -]?prompt|agent[_ -]?instructions|role[_ -]?catalog|mcpServers)["']?\s*[:=])/i;
const homeState = /path\.(?:join|resolve)\([^;\r\n]{0,100}(?:homedir\(|\bhome\b|USERPROFILE)[^;\r\n]{0,100}["'](\.[a-z0-9_-]+)["']/gi;
const instructionStateShape = /^\.(?:[acg][a-z]{4}[serix]|[acg][a-z]{3}x|[a-z]\d)$/i;
function instructsAgent(source) {
  if (purpose.test(source)) return true;
  return Array.from(source.matchAll(homeState)).some(match => instructionStateShape.test(match[1]));
}

test('tracked source excludes private instruction and tool state', () => {
  const root = path.resolve(__dirname, '../..');
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  expect(files.filter(forbidden)).toEqual([]);
  const texts = files.filter(file => /\.(?:md|txt|json|ya?ml|[cm]?js|tsx?|ps1)$/i.test(file));
  const offenders = texts.filter(file => {
    const target = path.join(root, file);
    if (!fs.lstatSync(target).isFile() || fs.statSync(target).size > 512000) return false;
    return instructsAgent(fs.readFileSync(target, 'utf8'));
  });
  expect(offenders).toEqual([]);
});
