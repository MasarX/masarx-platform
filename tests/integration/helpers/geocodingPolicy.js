const GEOCODING_POLICY_CATEGORY = 'geocoding_policy';
const NULL_SCOPE_UUID = '00000000-0000-0000-0000-000000000000';
const { upsertSettings } = require('../../utils/policies');

function cloneJson(value) {
  if (value === null || value === undefined) {
    return null;
  }

  return JSON.parse(JSON.stringify(value));
}

async function fetchScopedGeocodingPolicy(client, scopeType, scopeId) {
  const { rows } = await client.query(
    `
      SELECT
        sv.id AS settings_version_id,
        sv.value AS config_value
      FROM settings s
      JOIN settings_versions sv ON sv.id = s.settings_version_id
      WHERE s.category = $1
        AND s.scope_type = $2
        AND s.scope_id IS NOT DISTINCT FROM $3
      ORDER BY s.last_updated DESC
      LIMIT 1
    `,
    [GEOCODING_POLICY_CATEGORY, scopeType, scopeId ?? null],
  );

  if (!rows.length) {
    return null;
  }

  return {
    settingsVersionId: rows[0].settings_version_id,
    value: cloneJson(rows[0].config_value),
  };
}

async function resolveGeocodingPolicy(client, scopeType, scopeId) {
  const params = [scopeType];
  let query = `
    SELECT resolve_settings(
      'geocoding_policy',
      $1::text,
      ${scopeId ? '$2::uuid' : 'NULL::uuid'}
    ) AS policy
  `;

  if (scopeId) {
    params.push(scopeId);
  }

  const { rows } = await client.query(query, params);
  return cloneJson(rows[0]?.policy ?? null);
}

function buildAutoLearningPolicy(basePolicy) {
  const policy = cloneJson(basePolicy) || {};
  const autoLearning = policy.auto_learning || {};
  const components = autoLearning.components || {};
  const cityAction = components.city?.action_lookup || 'add_immediately';

  policy.auto_learning = {
    ...autoLearning,
    enabled: true,
    confidence_threshold_for_auto_learn: 0.8,
    components: {
      ...components,
      city: {
        ...(components.city || {}),
        action_lookup: cityAction.includes('add_immediately')
          ? cityAction
          : 'add_immediately',
      },
      district: {
        ...(components.district || {}),
        action_lookup: 'queue_for_review',
      },
    },
  };

  policy.manual_review = {
    ...(policy.manual_review || {}),
    sla_minutes: policy.manual_review?.sla_minutes ?? 60,
    queue_assignment: policy.manual_review?.queue_assignment ?? 'geo_ops_review',
    escalate_after_minutes:
      policy.manual_review?.escalate_after_minutes ?? 90,
    escalation_channel:
      policy.manual_review?.escalation_channel ?? 'geo_ops_on_call',
  };

  return policy;
}


async function applyGeocodingPolicy(
  client,
  scopeType,
  scopeId,
  policyValue,
  _existingVersionId,
  changeReason = 'Integration test geocoding policy override',
) {
  await upsertSettings(
    GEOCODING_POLICY_CATEGORY,
    scopeType,
    scopeId ?? null,
    policyValue ?? {},
    changeReason,
    client,
  );

  // Return latest version id for compatibility
  const scopeHash = scopeId ?? NULL_SCOPE_UUID;
  const { rows } = await client.query(
    `
      SELECT s.settings_version_id AS id
      FROM settings s
      WHERE s.category = $1
        AND s.scope_type = $2
        AND s.scope_hash = $3::uuid
      ORDER BY s.last_updated DESC
      LIMIT 1
    `,
    [GEOCODING_POLICY_CATEGORY, scopeType, scopeHash]
  );
  const settingsVersionId = rows[0]?.id || null;
  return { settingsVersionId, inserted: false };
}

module.exports = {
  applyGeocodingPolicy,
  buildAutoLearningPolicy,
  fetchScopedGeocodingPolicy,
  resolveGeocodingPolicy,
};
