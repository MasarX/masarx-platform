#!/usr/bin/env node
/**
 * set-360dialog-recipient.js
 *
 * Updates the provider_defaults.default_recipient for the dialog360_whatsapp provider.
 * Usage:
 *   node scripts/qa/set-360dialog-recipient.js --to +9665XXXXXXXX
 * or set env DIALOG360_DEFAULT_RECIPIENT and run without --to.
 *
 * For multi-tenant databases, provide an organization context:
 *   node scripts/qa/set-360dialog-recipient.js --organization-slug <org-slug> --to +9665XXXXXXXX
 * or set ORGANIZATION_SLUG / ORGANIZATION_ID in the environment.
 */
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');
const { parseFlagArgs } = require('../utils/cli-args');
const { resolveProvider } = require('../utils/provider-resolver');

function normalizeRecipient(value) {
  if (!value) return value;
  const digits = String(value).replace(/[^\d+]/g, '');
  if (!digits.length) return undefined;
  if (digits.startsWith('+')) return digits.slice(1);
  return digits;
}

async function main() {
  loadEnv();
  const flags = parseFlagArgs(process.argv.slice(2));
  const to = flags.to;
  const orgOptions = {
    organizationId: flags['organization-id'] || process.env.ORGANIZATION_ID,
    organizationSlug: flags['organization-slug'] || process.env.ORGANIZATION_SLUG,
  };
  const input = to || process.env.DIALOG360_DEFAULT_RECIPIENT;
  if (!input) {
    console.error('[set-360dialog-recipient] Missing recipient. Use --to +9665XXXXXXX or set DIALOG360_DEFAULT_RECIPIENT');
    process.exit(1);
  }
  const recipient = normalizeRecipient(input);
  if (!recipient) {
    console.error('[set-360dialog-recipient] Invalid recipient format. Provide E.164 (+966...) or digits.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Resolve provider id
    const { providerId } = await resolveProvider(
      client,
      'dialog360_whatsapp',
      orgOptions,
    );

    // Upsert settings_versions + settings (append-only versions; never mutate historical rows).
    const { rows: settingsRows } = await client.query(
      `
        SELECT settings_version_id, cached_value
        FROM settings
        WHERE category = 'provider_defaults'
          AND scope_type = 'resource'
          AND scope_id = $1::uuid
        ORDER BY last_updated DESC NULLS LAST
        LIMIT 1
      `,
      [providerId]
    );

    const currentValue = settingsRows[0]?.cached_value || {};
    const nextValue = {
      ...currentValue,
      default_recipient: recipient,
    };

    const { rows: versionRows } = await client.query(
      `
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM settings_versions
        WHERE category = 'provider_defaults'
          AND scope_type = 'resource'
          AND scope_id = $1::uuid
      `,
      [providerId]
    );
    const nextVersion = Number(versionRows[0]?.next_version || 1);

    await client.query(
      `
        UPDATE settings_versions
        SET effective_until = now()
        WHERE category = 'provider_defaults'
          AND scope_type = 'resource'
          AND scope_id = $1::uuid
          AND effective_until IS NULL
      `,
      [providerId]
    );

    const ins = await client.query(
      `
        INSERT INTO settings_versions (
          category,
          scope_type,
          scope_id,
          version,
          value,
          schema_version,
          change_reason,
          approved_at,
          effective_from
        )
        VALUES (
          'provider_defaults',
          'resource',
          $1::uuid,
          $2::int,
          $3::jsonb,
          1,
          'Update 360dialog default_recipient (QA)',
          now(),
          now()
        )
        RETURNING id
      `,
      [providerId, nextVersion, JSON.stringify(nextValue)]
    );
    const settingsVersionId = ins.rows[0].id;

    await client.query(
      `
        INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
        VALUES ('provider_defaults','resource',$1::uuid,$2::uuid,$3::jsonb, now())
        ON CONFLICT (category, scope_type, scope_id)
        DO UPDATE SET
          settings_version_id = EXCLUDED.settings_version_id,
          cached_value = EXCLUDED.cached_value,
          last_updated = EXCLUDED.last_updated
      `,
      [providerId, settingsVersionId, JSON.stringify(nextValue)]
    );

    await client.query('COMMIT');
    console.log(`[set-360dialog-recipient] Updated default_recipient to ${recipient}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[set-360dialog-recipient] Failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
