const DEFAULT_ACTION = 'ignore';

const normalizeAction = (v) => {
  const raw = String(v || '').trim().toLowerCase();
  if (raw === 'fail') return 'fail';
  if (raw === 'warn') return 'warn';
  if (raw === 'ignore' || raw === 'none') return 'ignore';
  return DEFAULT_ACTION;
};

const normalizeQuality = (v) => {
  const raw = String(v || '').trim().toLowerCase();
  if (raw === 'ok') return 'ok';
  if (raw === 'at_risk') return 'at_risk';
  if (raw === 'unscannable') return 'unscannable';
  return 'unknown';
};

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

const matchesOverride = (meta, rule) => {
  if (!meta || typeof meta !== 'object' || !rule || typeof rule !== 'object') return false;
  if (isNonEmptyString(rule.value_path) && String(meta.value_path || '') !== String(rule.value_path)) return false;
  if (isNonEmptyString(rule.asset_ref) && String(meta.asset_ref || '') !== String(rule.asset_ref)) return false;
  if (isNonEmptyString(rule.block_type) && String(meta.block_type || '') !== String(rule.block_type)) return false;
  return true;
};

const resolveRule = (policy, meta) => {
  const base = policy && typeof policy === 'object' ? policy : {};
  const overrides = Array.isArray(base.overrides) ? base.overrides : [];
  const matched = overrides.find((r) => matchesOverride(meta, r));
  const merged = matched && typeof matched === 'object' ? { ...base, ...matched } : base;

  return {
    on_unscannable: normalizeAction(merged.on_unscannable),
    on_at_risk: normalizeAction(merged.on_at_risk),
    on_non_vector: normalizeAction(merged.on_non_vector),
  };
};

const actionForMeta = (meta, rule) => {
  const engine = String(meta?.engine || '');
  const quality = normalizeQuality(meta?.quality);

  if (engine === 'code128_vector') {
    if (quality === 'unscannable') return { action: rule.on_unscannable, reason: 'unscannable' };
    if (quality === 'at_risk') return { action: rule.on_at_risk, reason: 'at_risk' };
    return { action: 'ignore', reason: quality === 'ok' ? 'ok' : 'unknown_quality' };
  }

  if (engine === 'code128_png_bwip' || engine === 'barcode_text_fallback') {
    return { action: rule.on_non_vector, reason: 'non_vector' };
  }

  return { action: 'ignore', reason: 'unsupported_engine' };
};

const worstFailureReason = (violations) => {
  const reasons = new Set((violations || []).map((v) => v.reason));
  if (reasons.has('unscannable')) return 'barcode_unscannable';
  if (reasons.has('non_vector')) return 'barcode_non_vector';
  if (reasons.has('at_risk')) return 'barcode_at_risk';
  return 'barcode_policy_violation';
};

const evaluateBarcodeQualityPolicy = (policy, barcodeMeta) => {
  const blocks = Array.isArray(barcodeMeta) ? barcodeMeta : [];

  const violations = [];
  for (const meta of blocks) {
    const rule = resolveRule(policy, meta);
    const outcome = actionForMeta(meta, rule);
    if (!outcome || outcome.action === 'ignore') continue;
    violations.push({
      action: outcome.action,
      reason: outcome.reason,
      engine: meta.engine || null,
      value_path: meta.value_path || null,
      asset_ref: meta.asset_ref || null,
      quality: meta.quality || null,
    });
  }

  const toFail = violations.filter((v) => v.action === 'fail');
  const toWarn = violations.filter((v) => v.action === 'warn');

  return {
    should_fail: toFail.length > 0,
    should_warn: toWarn.length > 0,
    fail_reason: toFail.length > 0 ? worstFailureReason(toFail) : null,
    violations,
  };
};

module.exports = {
  normalizeAction,
  normalizeQuality,
  evaluateBarcodeQualityPolicy,
};

