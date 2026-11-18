#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');
const { resolveDatabaseUrlWithFallback } = require('../utils/resolve-db-url');

loadEnv();

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    runId: '',
    manifest: '',
    out: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    const next = String(argv[i + 1] || '').trim();
    if (!token) continue;
    if (token === '--run-id' && next) {
      out.runId = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--run-id=')) {
      out.runId = token.split('=').slice(1).join('=');
      continue;
    }
    if (token === '--manifest' && next) {
      out.manifest = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--manifest=')) {
      out.manifest = token.split('=').slice(1).join('=');
      continue;
    }
    if (token === '--out' && next) {
      out.out = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--out=')) {
      out.out = token.split('=').slice(1).join('=');
    }
  }
  return out;
}

async function resolveDatabaseUrl() {
  return resolveDatabaseUrlWithFallback({
    env: process.env,
    logger: console,
    label: 'frontend-a2z-seed-fixtures',
    connectionTimeoutEnv: 'UI_A2Z_DB_CONNECT_TIMEOUT_MS',
    maxWaitEnv: 'UI_A2Z_DB_CONNECT_MAX_WAIT_MS',
    retryDelayEnv: 'UI_A2Z_DB_CONNECT_RETRY_DELAY_MS',
  });
}

function ensureRunId(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '-');
  const trimmed = raw.replace(/^-+|-+$/g, '');
  const withPrefix = trimmed.startsWith('E2E-AZ-')
    ? trimmed
    : `E2E-AZ-${trimmed || Date.now()}`;
  return withPrefix;
}

function writeJson(filePath, payload) {
  const resolved = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resolved;
}

function appendMutationManifestEntries(manifestPath, entries) {
  if (!manifestPath || !Array.isArray(entries) || entries.length === 0) return;
  const resolved = path.resolve(process.cwd(), manifestPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  for (const entry of entries) {
    fs.appendFileSync(resolved, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

function readJsonSafe(filePath) {
  const resolved = path.resolve(process.cwd(), String(filePath || '').trim());
  if (!resolved || !fs.existsSync(resolved)) return null;
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim()
  );
}

function readDemoManifestScopeIds(manifestPath) {
  const payload = readJsonSafe(manifestPath);
  const users = Array.isArray(payload?.users) ? payload.users : [];
  const clientIds = new Set();
  const senderIds = new Set();

  for (const user of users) {
    const scopeType = String(user?.scope_type || '').trim().toLowerCase();
    const scopeId = String(user?.scope_id || '').trim();
    if (!scopeType || !isUuidLike(scopeId)) continue;
    if (scopeType === 'client') {
      clientIds.add(scopeId);
      continue;
    }
    if (scopeType === 'sender') {
      senderIds.add(scopeId);
    }
  }

  return {
    clientIds: Array.from(clientIds),
    senderIds: Array.from(senderIds),
  };
}

async function resolveClientSeedsFromDemoManifest(client, manifestPath) {
  const scopeIds = readDemoManifestScopeIds(manifestPath);
  const mergedClientIds = new Set(scopeIds.clientIds);

  if (scopeIds.senderIds.length > 0) {
    try {
      const senderRes = await client.query(
        `
          SELECT DISTINCT s.client_id::text AS client_id
            FROM public.senders s
           WHERE s.id = ANY($1::uuid[])
        `,
        [scopeIds.senderIds],
      );
      for (const row of senderRes.rows || []) {
        const clientId = String(row?.client_id || '').trim();
        if (isUuidLike(clientId)) mergedClientIds.add(clientId);
      }
    } catch (_error) {
      // Continue with any direct client scope ids.
    }
  }

  const clientIds = Array.from(mergedClientIds);
  if (clientIds.length === 0) return [];

  const seeded = await client.query(
    `
      SELECT c.id::text AS client_id, c.organization_id::text AS organization_id
        FROM public.clients c
       WHERE c.id = ANY($1::uuid[])
       ORDER BY c.created_at DESC NULLS LAST
    `,
    [clientIds],
  );
  return Array.isArray(seeded.rows) ? seeded.rows : [];
}

async function resolveSenderSeedsFromDemoManifest(client, manifestPath) {
  const scopeIds = readDemoManifestScopeIds(manifestPath);
  if (scopeIds.senderIds.length === 0) return [];

  const seeded = await client.query(
    `
      SELECT
        s.id::text AS sender_id,
        s.client_id::text AS client_id,
        c.organization_id::text AS organization_id
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
      WHERE s.id = ANY($1::uuid[])
      ORDER BY s.created_at DESC NULLS LAST
    `,
    [scopeIds.senderIds],
  );
  return Array.isArray(seeded.rows) ? seeded.rows : [];
}

function buildTrackingNumber(runId, index) {
  const suffix = String(runId || '').slice(0, 18).replace(/[^A-Z0-9]+/g, '');
  return `${suffix}-${Date.now()}-${index + 1}`;
}

function buildLabelBarcode(runId, index) {
  const suffix = String(runId || '')
    .replace(/[^A-Z0-9]+/gi, '')
    .toUpperCase()
    .slice(-12);
  const normalizedSuffix = suffix || 'E2EAZ';
  return `E2E-LBL-${normalizedSuffix}-${String(index + 1).padStart(4, '0')}`;
}

async function resolveClientSeeds(client, options = {}) {
  const demoManifestPath = String(
    options.demoManifestPath || process.env.DEMO_ACCOUNTS_PATH || ''
  ).trim();
  if (demoManifestPath) {
    try {
      const scopedRows = await resolveClientSeedsFromDemoManifest(client, demoManifestPath);
      if (scopedRows.length > 0) {
        return {
          rows: scopedRows,
          source: 'demo_manifest',
        };
      }
    } catch (_error) {
      // Fall back to generic client sampling.
    }
  }

  const query = `
    SELECT c.id::text AS client_id, c.organization_id::text AS organization_id
      FROM public.clients c
     WHERE c.organization_id IS NOT NULL
     ORDER BY c.created_at DESC NULLS LAST
     LIMIT 4
  `;
  const fallback = `
    SELECT c.id::text AS client_id, c.organization_id::text AS organization_id
      FROM public.clients c
     LIMIT 4
  `;
  try {
    const res = await client.query(query);
    return {
      rows: Array.isArray(res.rows) ? res.rows : [],
      source: 'latest_clients',
    };
  } catch (_error) {
    const res = await client.query(fallback);
    return {
      rows: Array.isArray(res.rows) ? res.rows : [],
      source: 'fallback_clients',
    };
  }
}

async function resolveSenderSeeds(client, options = {}) {
  const demoManifestPath = String(
    options.demoManifestPath || process.env.DEMO_ACCOUNTS_PATH || ''
  ).trim();
  if (demoManifestPath) {
    try {
      const scopedRows = await resolveSenderSeedsFromDemoManifest(client, demoManifestPath);
      if (scopedRows.length > 0) {
        return {
          rows: scopedRows,
          source: 'demo_manifest',
        };
      }
    } catch (_error) {
      // Fall back to generic sender sampling.
    }
  }

  const query = `
    SELECT
      s.id::text AS sender_id,
      s.client_id::text AS client_id,
      c.organization_id::text AS organization_id
    FROM public.senders s
    JOIN public.clients c ON c.id = s.client_id
    WHERE c.organization_id IS NOT NULL
    ORDER BY s.created_at DESC NULLS LAST
    LIMIT 4
  `;
  const fallback = `
    SELECT
      s.id::text AS sender_id,
      s.client_id::text AS client_id,
      c.organization_id::text AS organization_id
    FROM public.senders s
    JOIN public.clients c ON c.id = s.client_id
    LIMIT 4
  `;
  try {
    const res = await client.query(query);
    return {
      rows: Array.isArray(res.rows) ? res.rows : [],
      source: 'latest_senders',
    };
  } catch (_error) {
    const res = await client.query(fallback);
    return {
      rows: Array.isArray(res.rows) ? res.rows : [],
      source: 'fallback_senders',
    };
  }
}

async function seedShipments({ client, runId, demoManifestPath = '' }) {
  const resolvedClientSeeds = await resolveClientSeeds(client, { demoManifestPath });
  const resolvedSenderSeeds = await resolveSenderSeeds(client, { demoManifestPath });
  const clientRows = Array.isArray(resolvedClientSeeds?.rows) ? resolvedClientSeeds.rows : [];
  const senderRows = Array.isArray(resolvedSenderSeeds?.rows) ? resolvedSenderSeeds.rows : [];
  const inserted = [];
  const errors = [];
  const manifestEntries = [];
  let insertIndex = 0;

  async function insertShipmentRow({
    organizationId,
    clientId,
    senderId = null,
    seedScope = 'client',
    seedScopeId = null,
    seedSource = 'unknown',
  }) {
    if (!organizationId || !clientId) return;
    const trackingNumber = buildTrackingNumber(runId, insertIndex);
    insertIndex += 1;
    try {
      const insert = await client.query(
        `
          INSERT INTO public.shipments (
            organization_id,
            client_id,
            sender_id,
            service_type,
            tracking_number,
            status,
            metadata
          ) VALUES (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            'delivery',
            $4,
            'created',
            jsonb_build_object(
              'e2e_seed', true,
              'seed_source', 'frontend-a2z-seed-fixtures',
              'seed_scope', $5::text,
              'seed_scope_id', $6::text,
              'run_id', $7::text
            )
          )
          RETURNING id::text
        `,
        [organizationId, clientId, senderId, trackingNumber, seedScope, seedScopeId, runId],
      );
      const shipmentId = String(insert.rows?.[0]?.id || '').trim();
      if (!shipmentId) return;
      inserted.push({
        shipment_id: shipmentId,
        organization_id: organizationId,
        client_id: clientId,
        sender_id: senderId || null,
        tracking_number: trackingNumber,
        seed_scope: seedScope,
        seed_source: seedSource,
      });
      manifestEntries.push({
        kind: 'shipment',
        id: shipmentId,
        label: `frontend-a2z:${runId}:seed`,
        run_id: runId,
        captured_at: new Date().toISOString(),
        metadata: {
          tracking_number: trackingNumber,
          organization_id: organizationId,
          client_id: clientId,
          sender_id: senderId || null,
          seed_scope: seedScope,
          seed_scope_id: seedScopeId,
          seed_source: 'frontend-a2z-seed-fixtures',
        },
      });
    } catch (error) {
      errors.push({
        organization_id: organizationId,
        client_id: clientId,
        sender_id: senderId || null,
        seed_scope: seedScope,
        message: String(error.message || error),
      });
    }
  }

  for (let index = 0; index < senderRows.length; index += 1) {
    const row = senderRows[index];
    const organizationId = String(row.organization_id || '').trim();
    const clientId = String(row.client_id || '').trim();
    const senderId = String(row.sender_id || '').trim();
    await insertShipmentRow({
      organizationId,
      clientId,
      senderId,
      seedScope: 'sender',
      seedScopeId: senderId || null,
      seedSource: resolvedSenderSeeds?.source,
    });
  }

  for (let index = 0; index < clientRows.length; index += 1) {
    const row = clientRows[index];
    const organizationId = String(row.organization_id || '').trim();
    const clientId = String(row.client_id || '').trim();
    await insertShipmentRow({
      organizationId,
      clientId,
      seedScope: 'client',
      seedScopeId: clientId || null,
      seedSource: resolvedClientSeeds?.source,
    });
  }

  return {
    client_seed_source: String(resolvedClientSeeds?.source || 'unknown'),
    sender_seed_source: String(resolvedSenderSeeds?.source || 'unknown'),
    demo_manifest_path: demoManifestPath ? path.resolve(process.cwd(), demoManifestPath) : null,
    attempted: senderRows.length + clientRows.length,
    attempted_sender: senderRows.length,
    attempted_client: clientRows.length,
    inserted_count: inserted.length,
    inserted,
    errors,
    manifestEntries,
  };
}
async function seedPortalDispatchExceptionReview({ client, runId, seededShipments }) {
  const shipments = Array.isArray(seededShipments) ? seededShipments : [];
  const visibleShipments = shipments.filter((entry) => entry?.seed_source === 'demo_manifest');
  const shipment =
    visibleShipments.find((entry) => entry?.sender_id) || visibleShipments[0] || null;
  const inserted = [];
  const errors = [];
  const manifestEntries = [];
  if (!shipment) {
    errors.push({ message: 'demo_manifest_visible_shipment_missing' });
    return { attempted: 0, inserted_count: 0, inserted, errors, manifestEntries };
  }

  const payload = {
    task_type_key: 'dispatch_exception_review',
    context: {
      organization_id: shipment.organization_id,
      client_id: shipment.client_id,
      sender_id: shipment.sender_id || null,
      shipment_id: shipment.shipment_id,
      dispatch_exception_reason: 'customer_unavailable',
      service_type: 'delivery',
    },
    resource_type: 'shipment',
    resource_id: shipment.shipment_id,
    idempotency_key: `frontend-a2z:${runId}:dispatch-exception-review:${shipment.shipment_id}`,
    actor_system: 'frontend-a2z-seed-fixtures',
    metadata: {
      e2e_seed: true,
      seed_source: 'frontend-a2z-seed-fixtures',
      run_id: runId,
      dispatch_exception_reason: 'customer_unavailable',
      service_type: 'delivery',
    },
  };

  try {
    const result = await client.query(
      'SELECT task_id::text FROM public.create_task_system_v1($1::jsonb) LIMIT 1',
      [JSON.stringify(payload)],
    );
    const taskId = String(result.rows?.[0]?.task_id || '').trim();
    if (!taskId) throw new Error('dispatch_exception_review task id missing');
    inserted.push({
      task_id: taskId,
      shipment_id: shipment.shipment_id,
      client_id: shipment.client_id,
      sender_id: shipment.sender_id || null,
    });
    manifestEntries.push({
      kind: 'task',
      id: taskId,
      label: `frontend-a2z:${runId}:dispatch-exception-review`,
      run_id: runId,
      captured_at: new Date().toISOString(),
      metadata: {
        shipment_id: shipment.shipment_id,
        client_id: shipment.client_id,
        sender_id: shipment.sender_id || null,
        seed_source: 'frontend-a2z-seed-fixtures',
      },
    });
  } catch (error) {
    errors.push({
      shipment_id: shipment.shipment_id,
      message: String(error.message || error),
    });
  }

  return {
    attempted: 1,
    inserted_count: inserted.length,
    inserted,
    errors,
    manifestEntries,
  };
}


async function describeTableColumns(client, tableName) {
  const result = await client.query(
    `
      SELECT
        column_name,
        is_nullable,
        data_type,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position
    `,
    [tableName],
  );
  return Array.isArray(result.rows) ? result.rows : [];
}

function hasColumn(columnsByName, columnName) {
  return columnsByName.has(String(columnName || '').trim());
}

function isRequiredColumn(column) {
  const isNullable = String(column?.is_nullable || '').trim().toUpperCase();
  const hasDefault = String(column?.column_default || '').trim().length > 0;
  return isNullable === 'NO' && !hasDefault;
}

function buildLabelSeedValues({ shipment, runId, index }) {
  return {
    shipment_id: String(shipment?.shipment_id || '').trim(),
    client_id: String(shipment?.client_id || '').trim(),
    organization_id: String(shipment?.organization_id || '').trim(),
    label_type: 'shipping',
    barcode: buildLabelBarcode(runId, index),
    barcode_format: 'CODE128',
    file_url: `https://example.invalid/e2e/${encodeURIComponent(runId)}/${String(
      shipment?.shipment_id || '',
    ).trim()}.pdf`,
    file_size_bytes: 1024,
    print_count: 0,
    metadata: {
      e2e_seed: true,
      seed_source: 'frontend-a2z-seed-fixtures',
      run_id: runId,
      shipment_id: String(shipment?.shipment_id || '').trim(),
      client_id: String(shipment?.client_id || '').trim(),
      sender_id: String(shipment?.sender_id || '').trim() || null,
      seed_scope: String(shipment?.seed_scope || '').trim() || 'unknown',
    },
    renderer_metadata: {
      seeded_by: 'frontend-a2z-seed-fixtures',
      run_id: runId,
    },
  };
}

function resolveInsertableLabelColumns(columns, seedValues) {
  const columnNames = columns
    .map((column) => String(column?.column_name || '').trim())
    .filter(Boolean);
  const columnsByName = new Map();
  for (const column of columns) {
    columnsByName.set(String(column?.column_name || '').trim(), column);
  }

  const requiredColumns = columns
    .filter((column) => isRequiredColumn(column))
    .map((column) => String(column?.column_name || '').trim())
    .filter((columnName) => columnName !== 'id');

  const missingRequired = [];
  for (const columnName of requiredColumns) {
    if (!Object.prototype.hasOwnProperty.call(seedValues, columnName)) {
      missingRequired.push(columnName);
      continue;
    }
    const value = seedValues[columnName];
    if (value == null || value === '') {
      missingRequired.push(columnName);
    }
  }

  if (missingRequired.length > 0) {
    return {
      ok: false,
      missingRequired,
      columns: [],
      values: [],
    };
  }

  const insertColumns = [];
  const insertValues = [];
  for (const columnName of columnNames) {
    if (columnName === 'id') continue;
    if (!Object.prototype.hasOwnProperty.call(seedValues, columnName)) continue;
    const value = seedValues[columnName];
    if (value === undefined) continue;
    const column = columnsByName.get(columnName);
    if (!column) continue;
    if (value == null && String(column?.is_nullable || '').trim().toUpperCase() === 'NO') continue;
    insertColumns.push(columnName);
    insertValues.push(value);
  }

  return {
    ok: true,
    missingRequired: [],
    columns: insertColumns,
    values: insertValues,
  };
}

async function seedLabels({ client, runId, seededShipments }) {
  const inserted = [];
  const errors = [];
  const manifestEntries = [];
  const shipments = Array.isArray(seededShipments) ? seededShipments : [];

  if (shipments.length === 0) {
    return {
      attempted: 0,
      inserted_count: 0,
      inserted,
      errors,
      manifestEntries,
      skipped: true,
      reason: 'no_seeded_shipments',
    };
  }

  let labelColumns = [];
  try {
    labelColumns = await describeTableColumns(client, 'labels');
  } catch (error) {
    return {
      attempted: shipments.length,
      inserted_count: 0,
      inserted,
      errors: [
        {
          message: String(error.message || error),
          stage: 'describe_columns',
        },
      ],
      manifestEntries,
      skipped: true,
      reason: 'labels_schema_lookup_failed',
    };
  }

  if (labelColumns.length === 0) {
    return {
      attempted: shipments.length,
      inserted_count: 0,
      inserted,
      errors: [],
      manifestEntries,
      skipped: true,
      reason: 'labels_table_missing',
    };
  }

  for (let index = 0; index < shipments.length; index += 1) {
    const shipment = shipments[index];
    const seedValues = buildLabelSeedValues({ shipment, runId, index });
    const insertable = resolveInsertableLabelColumns(labelColumns, seedValues);
    if (!insertable.ok) {
      errors.push({
        shipment_id: seedValues.shipment_id,
        message: `missing_required_columns:${insertable.missingRequired.join(',')}`,
      });
      continue;
    }
    if (insertable.columns.length === 0) {
      errors.push({
        shipment_id: seedValues.shipment_id,
        message: 'no_insertable_columns',
      });
      continue;
    }

    const placeholders = insertable.columns
      .map((_, columnIndex) => `$${columnIndex + 1}`)
      .join(', ');
    const query = `
      INSERT INTO public.labels (${insertable.columns.join(', ')})
      VALUES (${placeholders})
      ON CONFLICT (barcode, shipment_id) DO NOTHING
      RETURNING id::text
    `;

    try {
      const result = await client.query(query, insertable.values);
      const labelId = String(result.rows?.[0]?.id || '').trim();
      if (!labelId) {
        errors.push({
          shipment_id: seedValues.shipment_id,
          barcode: seedValues.barcode,
          message: 'label_insert_conflict_or_not_returned',
        });
        continue;
      }
      inserted.push({
        label_id: labelId,
        shipment_id: seedValues.shipment_id,
        client_id: seedValues.client_id,
        organization_id: seedValues.organization_id,
        barcode: seedValues.barcode,
        label_type: seedValues.label_type,
      });
      manifestEntries.push({
        kind: 'label',
        id: labelId,
        label: `frontend-a2z:${runId}:seed`,
        run_id: runId,
        captured_at: new Date().toISOString(),
        metadata: {
          shipment_id: seedValues.shipment_id,
          client_id: seedValues.client_id,
          organization_id: seedValues.organization_id,
          barcode: seedValues.barcode,
          seed_source: 'frontend-a2z-seed-fixtures',
        },
      });
    } catch (error) {
      errors.push({
        shipment_id: seedValues.shipment_id,
        barcode: seedValues.barcode,
        message: String(error.message || error),
      });
    }
  }

  return {
    attempted: shipments.length,
    inserted_count: inserted.length,
    inserted,
    errors,
    manifestEntries,
    skipped: false,
    reason: null,
  };
}

async function checkWorkflowPrereq(client) {
  try {
    const res = await client.query(
      `SELECT count(*)::int AS count FROM public.workflow_templates WHERE status = 'active'`,
    );
    const count = Number(res.rows?.[0]?.count || 0);
    return {
      status: count > 0 ? 'ok' : 'partial',
      active_template_count: count,
    };
  } catch (error) {
    return {
      status: 'blocked',
      active_template_count: 0,
      error: String(error.message || error),
    };
  }
}

async function checkPrintCommandContract(client) {
  const out = {
    status: 'blocked',
    command_found: false,
    auto_download: false,
    output_url_paths_count: 0,
    poll_interval_ms: null,
    poll_timeout_ms: null,
    fallback_mode: null,
  };
  try {
    const res = await client.query(
      `
        SELECT sv.value
          FROM public.settings s
          JOIN public.settings_versions sv ON sv.id = s.settings_version_id
         WHERE s.category = 'ui_command_registry'
           AND s.scope_type = 'global'
           AND s.scope_id IS NULL
         LIMIT 1
      `,
    );
    const registry = res.rows?.[0]?.value;
    const commands = Array.isArray(registry?.commands) ? registry.commands : [];
    const command = commands.find((entry) => entry?.key === 'shipments.print_labels') ?? null;
    if (!command || typeof command !== 'object') {
      out.status = 'partial';
      return out;
    }
    out.command_found = true;
    const params =
      command.execution && typeof command.execution === 'object' && command.execution.params
        ? command.execution.params
        : null;
    const outputPaths = Array.isArray(params?.output_url_paths) ? params.output_url_paths : [];
    out.auto_download = params?.auto_download === true;
    out.output_url_paths_count = outputPaths.length;
    out.poll_interval_ms = Number(params?.poll_interval_ms || 0) || null;
    out.poll_timeout_ms = Number(params?.poll_timeout_ms || 0) || null;
    out.fallback_mode = typeof params?.fallback_mode === 'string' ? params.fallback_mode : null;
    out.status = out.auto_download && out.output_url_paths_count > 0 ? 'ok' : 'partial';
    return out;
  } catch (error) {
    return {
      ...out,
      error: String(error.message || error),
    };
  }
}

async function runSeedFixtures(args = parseArgs()) {
  const runId = ensureRunId(args.runId || process.env.E2E_A2Z_RUN_ID || Date.now());
  const report = {
    generated_at: new Date().toISOString(),
    run_id: runId,
    status: 'ok',
    manifest_path: args.manifest ? path.resolve(process.cwd(), args.manifest) : null,
    fixtures: {
      shipments: null,
      portal_dispatch_exception_review: null,
      labels: null,
      workflow_admin_prereq: null,
      label_prereq: null,
    },
    blockers: [],
  };

  const dbResolution = await resolveDatabaseUrl();
  const pool = new Pool({ connectionString: dbResolution.dsn });
  const client = await pool.connect();
  try {
    console.log(
      `[frontend-a2z-seed-fixtures] DB connected via ${dbResolution.candidateName} (attempts=${dbResolution.attempts}).`,
    );
    const shipments = await seedShipments({
      client,
      runId,
      demoManifestPath: String(process.env.DEMO_ACCOUNTS_PATH || '').trim(),
    });
    report.fixtures.shipments = shipments;
    appendMutationManifestEntries(args.manifest, shipments.manifestEntries || []);
    const dispatchExceptionReview = await seedPortalDispatchExceptionReview({
      client,
      runId,
      seededShipments: shipments.inserted || [],
    });
    report.fixtures.portal_dispatch_exception_review = dispatchExceptionReview;
    appendMutationManifestEntries(args.manifest, dispatchExceptionReview.manifestEntries || []);


    const labels = await seedLabels({
      client,
      runId,
      seededShipments: shipments.inserted || [],
    });
    report.fixtures.labels = labels;
    appendMutationManifestEntries(args.manifest, labels.manifestEntries || []);

    const workflowPrereq = await checkWorkflowPrereq(client);
    report.fixtures.workflow_admin_prereq = workflowPrereq;

    const labelPrereq = await checkPrintCommandContract(client);
    report.fixtures.label_prereq = labelPrereq;

    if ((shipments.inserted_count || 0) === 0) {
      report.status = 'partial';
      report.blockers.push('shipment_seed_none_inserted');
    }
    if ((dispatchExceptionReview.inserted_count || 0) === 0) {
      report.status = report.status === 'blocked' ? 'blocked' : 'partial';
      report.blockers.push('portal_dispatch_exception_review_none_inserted');
    }
    if (Array.isArray(dispatchExceptionReview.errors) && dispatchExceptionReview.errors.length > 0) {
      report.status = report.status === 'blocked' ? 'blocked' : 'partial';
      report.blockers.push('portal_dispatch_exception_review_errors_present');
    }
    if ((labels.inserted_count || 0) === 0) {
      report.status = report.status === 'blocked' ? 'blocked' : 'partial';
      report.blockers.push('label_seed_none_inserted');
    }
    if (Array.isArray(labels.errors) && labels.errors.length > 0) {
      report.status = report.status === 'blocked' ? 'blocked' : 'partial';
      report.blockers.push('label_seed_errors_present');
    }
    if (workflowPrereq.status !== 'ok') {
      report.status = report.status === 'blocked' ? 'blocked' : 'partial';
      report.blockers.push(`workflow_prereq_${workflowPrereq.status}`);
    }
    if (labelPrereq.status !== 'ok') {
      report.status = report.status === 'blocked' ? 'blocked' : 'partial';
      report.blockers.push(`label_prereq_${labelPrereq.status}`);
    }
  } finally {
    client.release();
    await pool.end();
  }

  return report;
}

async function main() {
  try {
    const args = parseArgs();
    const report = await runSeedFixtures(args);
    if (args.out) {
      const resolved = writeJson(args.out, report);
      console.log(`[frontend-a2z-seed-fixtures] wrote ${resolved}`);
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    process.exitCode = report.status === 'blocked' ? 2 : report.status === 'partial' ? 3 : 0;
  } catch (error) {
    console.error(`[frontend-a2z-seed-fixtures] ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  readDemoManifestScopeIds,
  resolveClientSeeds,
  resolveSenderSeeds,
  buildLabelBarcode,
  resolveInsertableLabelColumns,
  seedPortalDispatchExceptionReview,
  runSeedFixtures,
};
