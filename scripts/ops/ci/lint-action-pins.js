#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
const PINNED_DOCKER_IMAGE = /^(?:docker:\/\/)?[^\s@]+@sha256:[0-9a-f]{64}$/i;

function checkWorkflowFile(filePath, onLocalAction = () => {}) {
  const workflow = yaml.load(fs.readFileSync(filePath, 'utf8'));
  const violations = [];
  function checkUses(entry, location, reusableWorkflow = false, checkouts = []) {
    if (!entry || typeof entry !== 'object' || !Object.hasOwn(entry, 'uses')) return;
    const uses = entry.uses;
    if (typeof uses === 'string' && uses.startsWith('./')) {
      if (uses.includes('${{')) violations.push(`${filePath}: ${location} requires a static local action path`);
      else onLocalAction(uses, `${filePath}: ${location}`, reusableWorkflow, checkouts);
      return;
    }
    if (typeof uses === 'string' && uses.startsWith('docker://')) {
      if (!PINNED_DOCKER_IMAGE.test(uses)) {
        violations.push(`${filePath}: ${location} requires an immutable Docker sha256 digest`);
      }
    } else if (typeof uses !== 'string' || !/^[^\s@]+@[0-9a-f]{40}$/i.test(uses)) {
      violations.push(`${filePath}: ${location} requires a full action commit SHA`);
    }
  }
  function checkSteps(steps, location, checkouts = []) {
    if (!Array.isArray(steps)) {
      violations.push(`${filePath}: ${location} must be a list`);
      return;
    }
    steps.forEach((entry, index) => checkUses(entry, `${location}[${index}]`, false, checkouts));
  }
  for (const [jobName, job] of Object.entries(workflow?.jobs || {})) {
    checkUses(job, `jobs.${jobName}`, true);
    if (job && Object.hasOwn(job, 'steps')) {
      const steps = Array.isArray(job.steps) ? job.steps : [];
      const checkouts = steps.flatMap((step, index) => {
        if (!/^actions\/checkout@/i.test(step?.uses || '')) return [];
        const { repository, path: checkoutPath, ref } = step.with || {};
        const output = typeof ref === 'string'
          && ref.match(/^\$\{\{\s*steps\.([A-Za-z_][\w-]*)\.outputs\.[A-Za-z_][\w-]*\s*\}\}$/);
        return [{ index, path: checkoutPath,
          sameRepository: repository === undefined || repository === 'MasarX/MasarX'
            || (typeof repository === 'string' && /^\$\{\{\s*github\.repository\s*\}\}$/i.test(repository)),
          staticPath: typeof checkoutPath === 'string' && !checkoutPath.includes('${{'),
          trustedRef: ref === undefined || (typeof ref === 'string' && /^[0-9a-f]{40}$/i.test(ref))
            || Boolean(output && steps.slice(0, index).some(earlier => earlier?.id === output[1])),
        }];
      });
      if (steps.some(step => typeof step?.uses === 'string' && step.uses.startsWith('./'))) {
        for (const checkout of checkouts) {
          const location = `${filePath}: jobs.${jobName}.steps[${checkout.index}]`;
          if (!checkout.sameRepository) violations.push(`${location}: local actions require a same-repository checkout`);
          if (checkout.path !== undefined && !checkout.staticPath) {
            violations.push(`${location}: local actions require a literal checkout path`);
          }
        }
      }
      checkSteps(job.steps, `jobs.${jobName}.steps`, checkouts);
    }
  }
  if (workflow?.runs?.using === 'composite') checkSteps(workflow.runs.steps, 'runs.steps');
  if (workflow?.runs?.using === 'docker') {
    const image = workflow.runs.image;
    const localBuild = typeof image === 'string' && !image.includes('${{')
      && !image.startsWith('docker://') && !path.isAbsolute(image) && path.posix.basename(image) === 'Dockerfile';
    if (typeof image !== 'string' || (!localBuild && !PINNED_DOCKER_IMAGE.test(image))) {
      violations.push(`${filePath}: runs.image requires an immutable Docker sha256 digest or local Dockerfile`);
    }
  }
  return violations;
}

function checkRepository(root) {
  root = fs.realpathSync(root);
  const trackedFiles = fs.existsSync(path.join(root, '.git'))
    ? execFileSync('git', ['ls-files', '--cached', '-z'], {
      cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    }).split('\0') : null;
  const trackedDirectory = directory => trackedFiles
    ? trackedFiles.some(file => file.startsWith(`${path.relative(root, directory).split(path.sep).join('/')}/`))
    : fs.existsSync(directory);
  const files = [];
  const seen = new Set();
  const violations = [];
  const withinRoot = target => {
    const relative = path.relative(root, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  function addFile(target, location) {
    const actual = fs.realpathSync(target);
    if (!withinRoot(actual)) {
      violations.push(`${location}: action descriptor must stay within the repository`);
      return;
    }
    const file = path.relative(root, actual).split(path.sep).join('/');
    if (!seen.has(file)) { seen.add(file); files.push(file); }
  }
  for (const [directory, recursive] of [['.github/workflows', false], ['.github/actions', true]]) {
    const absolute = path.join(root, directory);
    if (!fs.existsSync(absolute)) continue;
    for (const name of fs.readdirSync(absolute, { recursive })) {
      if (recursive ? /^action\.ya?ml$/.test(path.basename(name)) : /\.ya?ml$/.test(name)) {
        addFile(path.join(absolute, name), name);
      }
    }
  }
  for (const file of files) {
    violations.push(...checkWorkflowFile(path.join(root, file), (uses, location, reusableWorkflow, checkouts) => {
      const localPath = path.resolve(root, uses);
      if (!withinRoot(localPath)) {
        violations.push(`${location}: local action must stay within the repository`);
        return;
      }
      const directories = [localPath];
      for (const checkout of checkouts) {
        // The ordinary repository checkout is already represented by this linted tree.
        if (checkout.path === undefined || !checkout.sameRepository || !checkout.staticPath) continue;
        const prefix = path.resolve(root, checkout.path);
        const relative = path.relative(prefix, localPath);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
        if (!withinRoot(prefix) || prefix === root || trackedDirectory(prefix) || !checkout.trustedRef) {
          violations.push(`${location}: local action checkout requires an isolated untracked path and trusted ref`);
          return;
        }
        directories.splice(0, directories.length, path.resolve(root, relative));
      }
      const candidates = reusableWorkflow ? [localPath]
        : directories.flatMap(directory => ['action.yml', 'action.yaml'].map(name => path.join(directory, name)));
      const descriptor = candidates.find(target => fs.existsSync(target));
      if (descriptor) addFile(descriptor, location);
      else violations.push(`${location}: local action descriptor not found`);
    }));
  }
  return { files: files.sort(), violations };
}

function main() {
  const { files, violations } = checkRepository(path.resolve(__dirname, '../../..'));
  if (violations.length) throw new Error(violations.join('\n'));
  console.log(`[lint-action-pins] OK (${files.length} workflow/action files)`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[lint-action-pins] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { checkRepository, checkWorkflowFile };
