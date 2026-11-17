function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function computeProjectName({ repo, prNumber }) {
  const repoName = String(repo || '').split('/').pop() || 'repo';
  const repoSlug = slugify(repoName) || 'repo';
  const prSlug = String(prNumber || '').trim();
  if (!/^\d+$/.test(prSlug)) {
    throw new Error(`Invalid PR number: ${prSlug || '<empty>'}`);
  }
  const base = `wk-${repoSlug}-pr-${prSlug}`;
  if (base.length <= 60) return base;
  const trimmedRepo = repoSlug.slice(0, Math.max(8, 60 - (`wk--pr-${prSlug}`.length)));
  return `wk-${trimmedRepo}-pr-${prSlug}`.slice(0, 60);
}

function extractPreviewWorkspaceFamilyName(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return '';
  const match = normalized.match(/^(wk-[a-z0-9-]+-pr-\d+)(?:-r-[a-z0-9]+)?$/i);
  return match && match[1] ? String(match[1]).toLowerCase() : '';
}

function extractPrNumberFromPreviewName(name) {
  const familyName = extractPreviewWorkspaceFamilyName(name);
  if (!familyName) return '';
  const match = familyName.match(/-pr-(\d+)$/i);
  return match && match[1] ? String(match[1]) : '';
}

function isPreviewWorkspaceFamilyMatch({ name, familyName }) {
  const normalizedFamily = String(familyName || '').trim().toLowerCase();
  if (!normalizedFamily) return false;
  return extractPreviewWorkspaceFamilyName(name) === normalizedFamily;
}

module.exports = {
  computeProjectName,
  extractPreviewWorkspaceFamilyName,
  extractPrNumberFromPreviewName,
  isPreviewWorkspaceFamilyMatch,
  slugify,
};
