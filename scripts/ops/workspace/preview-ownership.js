const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function normalize(value) {
  return String(value || '').trim();
}

function normalizeGeneration(value) {
  const parsed = Number.parseInt(normalize(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function buildGenerationToken(payload = {}) {
  const canonical = [
    normalize(payload.workspace_mode).toLowerCase(),
    normalize(payload.project_name).toLowerCase(),
    normalize(payload.project_ref).toLowerCase(),
    normalize(payload.branch_id).toLowerCase(),
    normalize(payload.branch_parent_ref).toLowerCase(),
    String(normalizeGeneration(payload.active_family_generation)),
    normalize(payload.run_id),
    normalize(payload.run_attempt),
  ].join('\n');
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function buildMaterializedOwnership(payload = {}) {
  const workspaceMode = normalize(payload.workspace_mode).toLowerCase();
  const projectRef = normalize(payload.project_ref).toLowerCase();
  const projectName = normalize(payload.project_name);
  const branchId = normalize(payload.branch_id);
  const branchParentRef = normalize(payload.branch_parent_ref).toLowerCase();
  if (!['project', 'branch'].includes(workspaceMode)) {
    throw new Error(`Invalid materialized preview workspace_mode: ${workspaceMode || '<missing>'}`);
  }
  if (!projectRef || !projectName) {
    throw new Error('Materialized preview ownership requires exact project_ref and project_name.');
  }
  if (!projectName.toLowerCase().startsWith('wk-')) {
    throw new Error(`Refusing non-preview workspace ownership: ${projectName}`);
  }
  if (workspaceMode === 'branch' && (!branchId || !branchParentRef)) {
    throw new Error('Materialized branch ownership requires exact branch_id and branch_parent_ref.');
  }
  if (workspaceMode === 'project' && (branchId || branchParentRef)) {
    throw new Error('Materialized project ownership must not carry branch identity.');
  }

  const ownership = {
    schema: 'preview-workspace-ownership.v1',
    materialized: true,
    provider: 'supabase',
    workspace_mode: workspaceMode,
    project_name: projectName,
    project_ref: projectRef,
    branch_id: branchId,
    branch_parent_ref: branchParentRef,
    active_family_generation: normalizeGeneration(payload.active_family_generation),
    run_id: normalize(payload.run_id),
    run_attempt: normalize(payload.run_attempt),
    materialized_at: normalize(payload.materialized_at) || new Date().toISOString(),
  };
  ownership.generation_token = buildGenerationToken(ownership);
  return ownership;
}

function writeJsonAtomic(filePath, payload) {
  const rawPath = String(filePath || '').trim();
  if (!rawPath) throw new Error('Missing preview ownership path.');
  const resolved = path.resolve(rawPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, resolved);
  return resolved;
}

function persistMaterializedOwnership(filePath, payload = {}) {
  const ownership = buildMaterializedOwnership(payload);
  writeJsonAtomic(filePath, ownership);
  return ownership;
}

function readMaterializedOwnership(filePath) {
  const resolved = String(filePath || '').trim();
  if (!resolved || !fs.existsSync(resolved)) return null;
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const ownership = buildMaterializedOwnership(parsed);
  if (normalize(parsed.generation_token) !== ownership.generation_token) {
    throw new Error('Preview workspace ownership generation token mismatch.');
  }
  return ownership;
}

function applyMaterializedOwnershipToManifest(manifest, ownership) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Preview manifest is required.');
  const exact = buildMaterializedOwnership(ownership);
  manifest.workspace_ownership = exact;
  manifest.active_family_generation = exact.active_family_generation;
  manifest.surfaces = manifest.surfaces && typeof manifest.surfaces === 'object'
    ? manifest.surfaces
    : {};
  manifest.surfaces.db = {
    ...(manifest.surfaces.db && typeof manifest.surfaces.db === 'object' ? manifest.surfaces.db : {}),
    provider: 'supabase',
    project_name: exact.project_name,
    project_ref: exact.project_ref,
    workspace_mode: exact.workspace_mode,
    branch_id: exact.branch_id,
    branch_parent_ref: exact.branch_parent_ref,
    ownership_generation_token: exact.generation_token,
  };
  return manifest;
}

module.exports = {
  applyMaterializedOwnershipToManifest,
  buildGenerationToken,
  buildMaterializedOwnership,
  persistMaterializedOwnership,
  readMaterializedOwnership,
  writeJsonAtomic,
};
