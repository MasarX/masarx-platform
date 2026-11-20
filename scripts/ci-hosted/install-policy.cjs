'use strict';
const { git } = require('./target-policy.cjs');

function workflowIgnore(text) {
  const lines = text.split(/\r?\n/); let inside = false;
  for (const line of lines) {
    if (line === 'env:') { inside = true; continue; }
    if (inside && line && !/^\s/.test(line)) break;
    if (inside && /^  NPM_CONFIG_IGNORE_SCRIPTS:\s*['"]?true['"]?\s*$/.test(line)) return true;
  }
  return false;
}
function installCommand(command, inherited = false) {
  const reset = /(?:NPM_CONFIG_IGNORE_SCRIPTS|npm_config_ignore_scripts)\s*(?:=|:)\s*['"]?(?:false|0)\b|--ignore-scripts[= ](?:false|0)\b/.test(command);
  if (reset && /\b(?:npm|pnpm|yarn)\b/.test(command)) return 'script-disabling override is false';
  const manager = /\b(npm|pnpm|yarn)\s+(?:(?:--(?:prefix|workspace|dir|cwd|userconfig|globalconfig)\s+(?!-)\S+|--[\w=./-]+|-g)\s+)*(?:ci|install|add|rebuild)\b/.exec(command);
  if (!manager) {
    if (/\b(?:pip3?|uv|apt(?:-get)?)\s+(?:[\w-]+\s+)*install\b/.test(command)) return 'unapproved installer';
    return null;
  }
  const explicit = /--ignore-scripts(?:=true)?\b|--mode[= ]skip-builds\b/.test(command);
  const env = !reset && (manager[1] === 'npm' || manager[1] === 'pnpm') && inherited;
  return !reset && (explicit || env) ? null : 'install lacks script disabling';
}
function checkInstallPolicy(files) {
  const errors = []; const workflows = [...files].filter(([name]) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(name));
  const inherited = workflows.length > 0 && workflows.every(([, text]) => workflowIgnore(text));
  for (const [name, text] of workflows) {
    if (!workflowIgnore(text)) errors.push(`${name}: workflow-level ignore-scripts setting missing`);
    for (const setting of text.matchAll(/^\s*(?:NPM_CONFIG_IGNORE_SCRIPTS|npm_config_ignore_scripts):\s*([^\n]*)$/gm)) {
      if (!/^['"]?true['"]?\s*$/.test(setting[1])) errors.push(`${name}: script-disabling override is not literal true`);
    }
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*(?:run:|(?:npm|pnpm|yarn|pip3?|uv|apt(?:-get)?)\s)/.test(line.trimStart())) {
        const error = installCommand(line, workflowIgnore(text));
        if (error) errors.push(`${name}: ${error}`);
      }
    }
  }
  for (const [name, text] of files) {
    if (!/^scripts\/ci-hosted\/.*\.(?:cjs|js|mjs|py)$/.test(name)) continue;
    if (/(?:NPM_CONFIG_IGNORE_SCRIPTS|npm_config_ignore_scripts)\s*[:=]\s*['"](?:false|0)['"]/.test(text)) errors.push(`${name}: helper disables the required ignore-scripts setting`);
    const calls = /(?:run|checked|spawnSync(?:Impl)?|spawn|execFile(?:Sync)?)\s*\(\s*['"](npm|pnpm|yarn|pip3?|uv|apt(?:-get)?)['"]\s*,\s*\[([^\]]*)\]/g;
    for (const match of text.matchAll(calls)) {
      const arguments_ = [...match[2].matchAll(/['"]([^'"]+)['"]/g)].map(item => item[1]).join(' ');
      const error = installCommand(`${match[1]} ${arguments_}`, inherited);
      if (error) errors.push(`${name}: ${error}`);
    }
    for (const match of text.matchAll(/(?:run|Popen|check_call|check_output|call)\s*\(\s*\[\s*['"](npm|pnpm|yarn|pip3?|uv|apt(?:-get)?)['"]\s*,([^\]]*)\]/g)) {
      const arguments_ = [...match[2].matchAll(/['"]([^'"]+)['"]/g)].map(item => item[1]).join(' ');
      const error = installCommand(`${match[1]} ${arguments_}`, inherited);
      if (error) errors.push(`${name}: ${error}`);
    }
    // shortcut: inspect literal shell installers and argv calls; review new dynamic dispatch before admitting it.
    for (const match of text.matchAll(/(?:execSync|exec)\s*\(\s*(['"])([^'"\n]+)\1/g)) {
      const error = installCommand(match[2], inherited);
      if (error) errors.push(`${name}: ${error}`);
    }
    if (/[?=]\s*\[\s*['"]install['"]\s*,\s*['"]--with-deps['"]/.test(text)) {
      const approved = name === 'scripts/ci-hosted/tasks.cjs'
        && /\['install', '--with-deps', 'chromium'\]/.test(text)
        && text.includes("require.resolve('@playwright/test/cli')");
      if (!approved) errors.push(`${name}: unapproved browser/OS installer`);
    }
  }
  return errors;
}

function installInputs(revision, read = git) {
  const names = read(['ls-tree', '-r', '--name-only', '-z', revision, '--', '.github/workflows', 'scripts/ci-hosted']).split('\0').filter(Boolean);
  return new Map(names.filter(name => /^\.github\/workflows\/.*\.ya?ml$|^scripts\/ci-hosted\/.*\.(?:cjs|js|mjs|py)$/.test(name))
    .map(name => [name, read(['show', `${revision}:${name}`])]));
}
function enforceWorkflowInventory(files) {
  if (!files.has('.github/workflows/public-ci.yml')) throw new Error('Required workflow is missing');
  const invalid = [...files.keys()].filter(file => file.startsWith('.github/workflows/') && !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file));
  if (invalid.length) throw new Error('Workflow must be a YAML file directly in the workflow directory');
}

if (require.main === module) {
  const files = installInputs('HEAD');
  enforceWorkflowInventory(files);
  const errors = checkInstallPolicy(files);
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
}
module.exports = { workflowIgnore, installCommand, checkInstallPolicy, enforceWorkflowInventory };
