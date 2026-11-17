const fs = require('fs');
const path = require('path');

const CONTRACT_RELATIVE_PATH = path.join(
  'config',
  'ci',
  'mobile-fieldops-release-env-contract.json',
);

function normalizeString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function resolveRepoRoot(startDir) {
  let current = path.resolve(startDir || process.cwd());
  while (true) {
    if (
      fs.existsSync(path.join(current, 'package.json')) &&
      fs.existsSync(path.join(current, 'apps', 'fieldops'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir || process.cwd());
    }
    current = parent;
  }
}

function loadFieldopsReleaseContract(startDir) {
  const repoRoot = resolveRepoRoot(startDir || process.cwd());
  const contractPath = path.join(repoRoot, CONTRACT_RELATIVE_PATH);
  if (!fs.existsSync(contractPath)) {
    return {
      repoRoot,
      contractPath,
      contract: null,
      error: new Error(`Missing ${CONTRACT_RELATIVE_PATH}`),
    };
  }

  try {
    return {
      repoRoot,
      contractPath,
      contract: JSON.parse(fs.readFileSync(contractPath, 'utf8')),
      error: null,
    };
  } catch (error) {
    return {
      repoRoot,
      contractPath,
      contract: null,
      error,
    };
  }
}

function resolveFieldopsAppSlug(contract) {
  return normalizeString(contract?.app?.slug);
}

module.exports = {
  CONTRACT_RELATIVE_PATH,
  loadFieldopsReleaseContract,
  resolveFieldopsAppSlug,
  resolveRepoRoot,
};
